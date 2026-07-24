/**
 * Overlay window entry.
 *
 * Two presentation modes:
 *  - "pill"   — small 420×96 floating pill (recording / processing / etc.)
 *  - "review" — 520×360 panel with editable text + Paste / Copy / Discard / Regenerate
 *
 * The main window picks which via the active Mode's `outputStyle`.
 */
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { RecordingPill } from "../components/recording/RecordingPill";
import { ReviewPanel } from "../components/recording/ReviewPanel";
import { startRecording, type AudioController } from "../lib/audio";
import { decodeToMonoF32_16k } from "../lib/ai/audioDecode";
import { encodeWavBlob } from "../lib/audio/wav";
import { trimSilence } from "../lib/vad/trim";
import { AutoStopDetector } from "../lib/vad/autoStop";
import { VAD_SAMPLE_RATE } from "../lib/vad/vad";
import {
  getReadyRealtimeSpeechModel,
  getTrimSpeechModel,
  warmupSpeechModel,
} from "../lib/vad/speechModel";
import { PartialSegmenter, type PartialTranscriptionPayload } from "../lib/transcribe/segmenter";
import { TranscriptionCoordinator } from "../lib/transcribe/coordinator";
import {
  StreamingTranscriber,
  isStreamingSidecarAvailable,
} from "../lib/transcribe/streamingClient";
import { getLocalWhisperTier, getWhisperComputePreference } from "../lib/ai/localWhisper";
import { mergeRollingPartialText } from "../lib/transcribe/textMerge";
import type { RecordingState } from "../lib/store/useRecording";
import { getActiveProvider } from "../lib/ai";
import { getModeById, getDefaultMode, loadVocabulary } from "../lib/store/useModes";
import { applyVocabReplacements } from "../lib/vocab";
import { resizeOverlayToPill, resizeOverlayToReview } from "../lib/recording-bridge";
import { pasteCleanedText, copyCleanedText, clearCapturedTarget } from "../lib/output";
import { osKind } from "../lib/os";
import { pasteMethodUsesClipboard } from "../lib/pasteMethod";
import {
  isAiImproveDisabled,
  getMicDeviceId,
  getOutputBehavior,
  getPasteMethod,
  isPerfDebugEnabled,
  isSilenceTrimEnabled,
  isAutoStopEnabled,
  isFillerFilterEnabled,
  isFuzzyVocabEnabled,
  isLivePartialEnabled,
  isTrueStreamingEnabled,
} from "../lib/preferences";
import { applyInlinePostProcessing } from "../lib/postProcess";
import { getPrivacyStatus, type DataLocality } from "../lib/privacyStatus";
import {
  classifyRecordingError,
  type RecordingErrorPresentation,
} from "../lib/recordingErrors";
import type { Mode } from "../types/mode";

function noPasteTargetMessage(): string {
  const behavior = getOutputBehavior();
  const method = behavior === "insert-only" ? "direct" : getPasteMethod();
  if (!pasteMethodUsesClipboard(method, osKind())) {
    return "[Verbatim AI] no paste target; clipboard unchanged because direct paste is enabled";
  }
  if (behavior === "restore") {
    return "[Verbatim AI] no paste target; previous clipboard will be restored";
  }
  return "[Verbatim AI] no paste target; copied to clipboard";
}

function shouldShowReviewWhenPasteMisses(): boolean {
  const behavior = getOutputBehavior();
  const method = behavior === "insert-only" ? "direct" : getPasteMethod();
  return !pasteMethodUsesClipboard(method, osKind()) || behavior === "restore";
}

type View = "pill" | "review";

export default function Overlay() {
  const [state, setState] = useState<RecordingState>("idle");
  const [view, setView] = useState<View>("pill");
  const [modeName, setModeName] = useState("Default");
  const [error, setError] = useState<string | null>(null);
  const [streamingCleaned, setStreamingCleaned] = useState("");
  const [rawText, setRawText] = useState("");
  const [partialText, setPartialText] = useState("");
  const [privacy, setPrivacy] = useState<DataLocality | null>(null);
  const [errorPresentation, setErrorPresentation] = useState<RecordingErrorPresentation | null>(
    null,
  );

  const controllerRef = useRef<AudioController | null>(null);
  const autoStopRef = useRef<AutoStopDetector | null>(null);
  const partialSegmenterRef = useRef<PartialSegmenter | null>(null);
  const partialCoordinatorRef = useRef<
    TranscriptionCoordinator<PartialTranscriptionPayload, string> | null
  >(null);
  const streamingRef = useRef<StreamingTranscriber | null>(null);
  const partialTextRef = useRef("");
  // Monotonic recording session id — guards stale live-partial results
  // from a previous recording landing in the current UI.
  const sessionRef = useRef(0);
  // In-flight getUserMedia: a stop/cancel that lands while the mic is
  // still being acquired must await this so the stream is never leaked.
  const startingRef = useRef<Promise<AudioController> | null>(null);
  const modeRef = useRef<Mode | null>(null);
  const hideRequestRef = useRef(0);
  // Dedup guard: the bridge re-emits recording:start until we ack, so ignore
  // duplicate deliveries for a session we're already handling.
  const handledSessionRef = useRef(0);

  const hideAfter = async (ms: number) => {
    const request = ++hideRequestRef.current;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    if (request !== hideRequestRef.current) return;
    try {
      await getCurrentWindow().hide();
    } catch {
      /* ignore */
    }
  };

  const cancelPendingHide = () => {
    hideRequestRef.current++;
  };

  const reset = async () => {
    setState("idle");
    setView("pill");
    setStreamingCleaned("");
    setRawText("");
    setPartialText("");
    partialTextRef.current = "";
    setError(null);
    setErrorPresentation(null);
    await resizeOverlayToPill();
    await clearCapturedTarget();
    await hideAfter(0);
  };

  /**
   * Tear down the live-partial machinery (Phase 6). Bumps the session id
   * so any transcribe request still in flight can't paint a stale partial
   * into the current UI, then disposes the coordinator + segmenter.
   */
  const disposeLivePartial = () => {
    sessionRef.current++;
    partialSegmenterRef.current?.dispose();
    partialSegmenterRef.current = null;
    partialCoordinatorRef.current?.dispose();
    partialCoordinatorRef.current = null;
    if (streamingRef.current) {
      // Terminate the streaming sidecar session (best-effort, async).
      void streamingRef.current.dispose();
      streamingRef.current = null;
    }
  };

  /**
   * True token-level streaming (issue #33, opt-in, default off). Streams live
   * 16 kHz PCM frames to a dedicated streaming sidecar and paints its
   * token-level partials into `partialText`. Supersedes the chunked
   * live-partial preview when active. Returns true if streaming was wired;
   * false (with no side effects) if unavailable, so the caller falls back to
   * the chunked path. The final stop→transcribe pipeline is never affected.
   */
  const setupTrueStreaming = async (
    sinks: Array<(frame: Float32Array) => void>,
  ): Promise<boolean> => {
    const session = sessionRef.current;
    const compute = getWhisperComputePreference();
    try {
      const available = await isStreamingSidecarAvailable(compute);
      // A stop/cancel may have superseded this recording during the probe.
      if (!available || sessionRef.current !== session) return false;

      const transcriber = new StreamingTranscriber({
        tier: getLocalWhisperTier(),
        computePreference: compute,
        onPartial: (partial) => {
          if (sessionRef.current !== session) return;
          const trimmed = partial.text.trim();
          if (!trimmed) return;
          partialTextRef.current = trimmed;
          setPartialText(trimmed);
        },
      });
      await transcriber.start();
      if (sessionRef.current !== session) {
        void transcriber.dispose();
        return false;
      }
      streamingRef.current = transcriber;
      sinks.push((frame) => transcriber.push(frame));
      return true;
    } catch (e) {
      // Sidecar missing / failed to start — fall back to the chunked path.
      if (import.meta.env.DEV) console.warn("[Verbatim AI] true streaming unavailable:", e);
      return false;
    }
  };

  /**
   * Build the live-partial coordinator + segmenter and register a frame
   * sink into `sinks`. Each partial re-transcribes either the audio-so-far
   * or (for long recordings) a bounded rolling window through the active
   * provider; results paint into `partialText` only if they belong to the
   * current recording session (stale-result guard).
   */
  const setupLivePartial = (mode: Mode | null, sinks: Array<(frame: Float32Array) => void>) => {
    const provider = getActiveProvider(mode);
    const activeMode = mode ?? getDefaultMode();
    if (!provider || !activeMode) return;
    const session = sessionRef.current;
    const vocab = loadVocabulary().map((t) => t.term);

    const coordinator = new TranscriptionCoordinator<PartialTranscriptionPayload, string>({
      run: async (payload) => {
        const wav = encodeWavBlob(payload.pcm, VAD_SAMPLE_RATE);
        const res = await provider.transcribe({
          audio: wav,
          language: activeMode.language || "auto",
          vocabularyHints: vocab,
        });
        return res.text ?? "";
      },
      onResult: (text, payload) => {
        // Ignore results from a superseded recording session.
        if (sessionRef.current !== session) return;
        const trimmed = text.trim();
        if (!trimmed) return;
        const next = payload.isFullContext
          ? trimmed
          : mergeRollingPartialText(partialTextRef.current, trimmed);
        partialTextRef.current = next;
        setPartialText(next);
      },
      onError: (e) => {
        // Partials are a best-effort preview — never surface their
        // failures. Log only in dev.
        if (import.meta.env.DEV) console.warn("[Verbatim AI] live partial failed:", e);
      },
    });
    partialCoordinatorRef.current = coordinator;

    const segmenter = new PartialSegmenter({
      onPartial: (payload) => coordinator.submit(payload),
    });
    partialSegmenterRef.current = segmenter;
    sinks.push((frame) => segmenter.push(frame));
  };

  const start = async (mode: string, modeId: string | null, pressedAt?: number, sessionId = 0) => {
    cancelPendingHide();
    setError(null);
    setErrorPresentation(null);
    setStreamingCleaned("");
    setRawText("");
    setPartialText("");
    partialTextRef.current = "";
    setView("pill");
    setModeName(mode);
    modeRef.current = getModeById(modeId) ?? getDefaultMode();
    setPrivacy(getPrivacyStatus(modeRef.current).overall);
    try {
      // Frame sinks fan out the real-time PCM frames (Phase 3) to any
      // opt-in consumers. Each is independent and default-off, so the
      // plain push-to-talk path wires nothing.
      autoStopRef.current = null;
      partialSegmenterRef.current = null;
      partialCoordinatorRef.current = null;
      streamingRef.current = null;
      const sinks: Array<(frame: Float32Array) => void> = [];

      // Hands-free auto-stop (opt-in): feed live frames to a VAD
      // endpointer that stops the recording after a hangover of silence.
      if (isAutoStopEnabled()) {
        // Use Silero only if already warm; never block mic capture on a
        // cold model load. Falls back to the energy VAD (undefined ⇒
        // SmoothedVad default) and warms up for the next recording.
        const model = getReadyRealtimeSpeechModel();
        const detector = new AutoStopDetector({
          model,
          onSilence: () => {
            void stop();
          },
        });
        autoStopRef.current = detector;
        sinks.push((frame) => detector.push(frame));
      }

      // Live preview engines (opt-in). True token-level streaming (#33)
      // supersedes the chunked pseudo-streaming preview when enabled and its
      // sidecar is available; otherwise we fall back to the chunked path.
      // Both are best-effort previews — the final stop→transcribe pipeline is
      // authoritative and untouched.
      let previewWired = false;
      if (isTrueStreamingEnabled()) {
        previewWired = await setupTrueStreaming(sinks);
      }
      if (!previewWired && isLivePartialEnabled()) {
        setupLivePartial(modeRef.current, sinks);
      }

      const onFrame =
        sinks.length > 0
          ? (frame: Float32Array) => {
              for (const sink of sinks) sink(frame);
            }
          : undefined;
      // The bridge shows this window concurrently — don't wait for it.
      // Opening the mic immediately is what keeps the first syllable
      // from being lost (docs/improvement-plan/04-performance-latency.md).
      const starting = startRecording({
        deviceId: getMicDeviceId() || undefined,
        onFrame,
        onError: (e) => {
          setError(e.message);
          setErrorPresentation(null);
          setState("error");
        },
      });
      startingRef.current = starting;
      const controller = await starting;
      if (startingRef.current === starting) {
        controllerRef.current = controller;
        setState("recording");
        // Confirm to the bridge that the mic is actually open so the hotkey
        // state machine can commit to "recording" (or stop cleanly).
        if (sessionId) void emit("recording:listening", { sessionId });
        if (pressedAt && isPerfDebugEnabled()) {
          console.info(`[perf] press→listening ${Date.now() - pressedAt}ms`);
        }
      }
      // else: a stop/cancel consumed this start while the mic was
      // being acquired — that path owns the controller now.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setErrorPresentation(null);
      setState("error");
      // Tell the bridge the mic never opened so startRecording rejects and the
      // hotkey state machine resets instead of believing it is recording.
      if (sessionId) void emit("recording:error", { sessionId, message: msg });
      void hideAfter(2500);
    }
  };

  const runCleanup = async (raw: string, activeMode: Mode, vocab: string[]): Promise<string> => {
    const provider = getActiveProvider(activeMode);
    if (!provider) throw new Error("Provider not configured");

    setStreamingCleaned("");
    let acc = "";
    for await (const chunk of provider.cleanup({
      rawText: raw,
      systemPrompt: activeMode.systemPrompt,
      modeName: activeMode.name,
      modeDescription: activeMode.description,
      vocabulary: vocab,
      targetLanguage: activeMode.targetLanguage ?? undefined,
    })) {
      acc += chunk;
      setStreamingCleaned(acc);
    }
    return acc;
  };

  const runPipeline = async (audio: Blob, durationMs: number, mode: string) => {
    const provider = getActiveProvider(modeRef.current);
    if (!provider) {
      setError("Configure Azure in Settings → AI to enable transcription.");
      setState("error");
      void hideAfter(3500);
      return;
    }
    const activeMode = modeRef.current ?? getDefaultMode();
    if (!activeMode) {
      setError("No Modes available. Sign in or wait for sync.");
      setState("error");
      void hideAfter(3500);
      return;
    }
    const vocabularyAll = loadVocabulary();
    const vocabularyTerms = vocabularyAll.map((t) => t.term);

    // Post-hoc VAD silence trim (Phase 4a). Runs before transcription to
    // drop leading/trailing silence and pure-noise clips. Fails open: any
    // decode/trim error falls back to the original audio untouched.
    let audioForTranscribe = audio;
    if (isSilenceTrimEnabled()) {
      try {
        const pcm = await decodeToMonoF32_16k(audio);
        // Prefer the Silero model (precomputed over the whole clip);
        // falls back to the energy VAD if it can't load.
        const model = await getTrimSpeechModel(pcm);
        const trim = trimSilence(pcm, model ? { model } : undefined);
        if (trim.isSilent) {
          // No detectable speech and ~no energy — treat as accidental.
          void reset();
          return;
        }
        if (trim.trimmed) {
          audioForTranscribe = encodeWavBlob(trim.pcm, VAD_SAMPLE_RATE);
          if (isPerfDebugEnabled()) {
            console.info(
              `[perf] VAD trim -${Math.round(trim.leadingTrimmedMs)}ms lead / -${Math.round(
                trim.trailingTrimmedMs,
              )}ms tail`,
            );
          }
        }
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[Verbatim AI] VAD trim skipped:", e);
      }
    }

    try {
      setState("processing");
      const transcript = await provider.transcribe({
        audio: audioForTranscribe,
        durationMs,
        language: activeMode.language || "auto",
        vocabularyHints: vocabularyTerms,
      });

      // ── Inline post-processing (P2.9) ──────────────────────────────────
      // Deterministic, LLM-free step applied to the raw transcript BEFORE
      // the cleanup-LLM so fillers are absent from the LLM context and
      // near-miss vocab terms are corrected upfront.
      // Both features are OFF by default; zero output change unless the
      // user explicitly enables them in Settings.
      const processedText = applyInlinePostProcessing(transcript.text, {
        fillerFilter: isFillerFilterEnabled(),
        fuzzyVocab: isFuzzyVocabEnabled(),
        vocabularyTerms: vocabularyAll,
      });

      setRawText(processedText);

      // Branch on output style BEFORE polishing so review users see
      // tokens stream into the editor in real time.
      if (activeMode.outputStyle === "review") {
        await resizeOverlayToReview();
        setView("review");
      }

      let cleaned: string;
      if (activeMode.skipCleanup || isAiImproveDisabled()) {
        // Fast path: skip the LLM entirely; vocab replacements still run.
        cleaned = applyVocabReplacements(processedText, vocabularyAll);
        setStreamingCleaned(cleaned);
      } else {
        setState("polishing");
        const cleanedRaw = await runCleanup(processedText, activeMode, vocabularyTerms);
        cleaned = applyVocabReplacements(cleanedRaw, vocabularyAll);
        if (cleaned !== cleanedRaw) setStreamingCleaned(cleaned);
      }

      // Transcript content is only ever logged in dev builds — release
      // builds must not emit dictation content to any console/log
      // (docs/improvement-plan/05-security-privacy.md, F1).
      if (import.meta.env.DEV) {
        console.info("[Verbatim AI] raw:", transcript.text);
        console.info("[Verbatim AI] cleaned:", cleaned);
      }
      const payload = {
        emitId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        raw: transcript.text,
        cleaned,
        durationMs,
        language: transcript.languageDetected,
        modeName: mode,
        modeId: activeMode.id,
        outputStyle: activeMode.outputStyle,
        saveHistory: activeMode.saveHistory,
      };

      if (activeMode.outputStyle === "paste") {
        const pasted = await pasteCleanedText(cleaned);
        if (!pasted && shouldShowReviewWhenPasteMisses()) {
          console.info(noPasteTargetMessage());
          await resizeOverlayToReview();
          setView("review");
          await invoke("relay_event", {
            name: "recording:result",
            payload: { ...payload, outputStyle: "review" },
          });
          setState("idle");
          return;
        }
        await invoke("relay_event", { name: "recording:result", payload });
        if (!pasted) {
          console.info(noPasteTargetMessage());
        }
        setState("success");
        setTimeout(() => void reset(), 900);
      } else {
        await invoke("relay_event", { name: "recording:result", payload });
        // Review panel stays open until user acts.
        setState("idle");
      }
    } catch (e) {
      const presentation = classifyRecordingError(e);
      console.error("[Verbatim AI] pipeline error:", e);
      void invoke("relay_event", {
        name: "recording:error",
        payload: presentation,
      });
      setErrorPresentation(presentation);
      setError(presentation.message);
      setState("error");
      if (presentation.persistent) {
        cancelPendingHide();
      } else {
        void hideAfter(3500);
      }
    }
  };

  const stop = async () => {
    autoStopRef.current?.disable();
    autoStopRef.current = null;
    // Tear down live partials up front so an in-flight partial transcribe
    // can't contend with the final full-quality transcription below.
    disposeLivePartial();
    let c = controllerRef.current;
    controllerRef.current = null;
    const starting = startingRef.current;
    startingRef.current = null;
    if (!c && starting) {
      // Mic acquisition still in flight — adopt it so the stream is
      // stopped instead of leaking.
      try {
        c = await starting;
      } catch {
        c = null;
      }
    }
    if (!c) {
      void reset();
      return;
    }
    setState("processing");
    const result = await c.stop();
    if (!result || result.durationMs < 300) {
      // Accidental tap — nothing worth transcribing.
      void reset();
      return;
    }
    await runPipeline(result.blob, result.durationMs, modeName);
  };

  const cancelActive = () => {
    autoStopRef.current?.disable();
    autoStopRef.current = null;
    disposeLivePartial();
    const starting = startingRef.current;
    startingRef.current = null;
    const c = controllerRef.current;
    controllerRef.current = null;
    if (c) {
      c.cancel();
    } else if (starting) {
      // Mic still being acquired — cancel it once it materializes.
      void starting.then((ctrl) => ctrl.cancel()).catch(() => {});
    }
    void reset();
  };

  // Review panel actions

  const handleReviewPaste = async (text: string) => {
    const ok = await pasteCleanedText(text);
    if (!ok && shouldShowReviewWhenPasteMisses()) {
      console.info(noPasteTargetMessage());
      return;
    }
    const payload = {
      emitId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action: ok ? ("pasted" as const) : ("copied" as const),
      cleaned: text,
      modeId: modeRef.current?.id ?? null,
    };
    await invoke("relay_event", { name: "recording:reviewed", payload });
    void reset();
  };

  const handleReviewCopy = async (text: string) => {
    await copyCleanedText(text);
    const payload = {
      emitId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action: "copied" as const,
      cleaned: text,
      modeId: modeRef.current?.id ?? null,
    };
    await invoke("relay_event", { name: "recording:reviewed", payload });
    void reset();
  };

  const handleReviewDiscard = async () => {
    const payload = {
      emitId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action: "discarded" as const,
      cleaned: streamingCleaned,
      modeId: modeRef.current?.id ?? null,
    };
    await invoke("relay_event", { name: "recording:reviewed", payload });
    void reset();
  };

  const handleReviewRegenerate = async () => {
    const activeMode = modeRef.current ?? getDefaultMode();
    if (!activeMode) return;
    const vocabAll = loadVocabulary();
    const vocab = vocabAll.map((t) => t.term);
    setState("polishing");
    try {
      const cleanedRaw = await runCleanup(rawText, activeMode, vocab);
      const cleaned = applyVocabReplacements(cleanedRaw, vocabAll);
      if (cleaned !== cleanedRaw) setStreamingCleaned(cleaned);
      setState("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setErrorPresentation(null);
      setState("error");
    }
  };

  useEffect(() => {
    let unlisteners: Array<() => void> = [];
    let disposed = false;
    void (async () => {
      // Subscribe BEFORE announcing readiness so a recording:start emitted by
      // the main window can never race ahead of our listener and be silently
      // dropped (the "mic never opens" bug).
      const [offStart, offStop, offCancel] = await Promise.all([
        listen<{
          modeName?: string;
          modeId?: string | null;
          pressedAt?: number;
          sessionId?: number;
        }>("recording:start", (e) => {
          const sessionId = e.payload?.sessionId ?? 0;
          // The bridge re-emits until we ack; ignore duplicates for a
          // session we're already handling.
          if (sessionId !== 0 && sessionId === handledSessionRef.current) return;
          handledSessionRef.current = sessionId;
          void start(
            e.payload?.modeName ?? "Default",
            e.payload?.modeId ?? null,
            e.payload?.pressedAt,
            sessionId,
          );
        }),
        listen("recording:stop", () => {
          void stop();
        }),
        listen("recording:cancel", () => {
          cancelActive();
        }),
      ]);
      if (disposed) {
        offStart();
        offStop();
        offCancel();
        return;
      }
      unlisteners = [offStart, offStop, offCancel];
      // Listeners are live now — tell the main window we're ready.
      void emit("overlay:ready");
    })();
    // Warm the Silero VAD session so the first recording's VAD paths
    // don't block on a cold model load. No-op if Silero is disabled.
    warmupSpeechModel();
    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Press Esc inside the overlay to cancel (recording mode only —
  // review panel handles Esc itself to discard).
  useEffect(() => {
    if (view === "review") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelActive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent p-3">
      {view === "review" ? (
        <ReviewPanel
          modeName={modeName}
          initialText={streamingCleaned}
          streamingText={streamingCleaned}
          isPolishing={state === "polishing"}
          onPaste={handleReviewPaste}
          onCopy={handleReviewCopy}
          onDiscard={handleReviewDiscard}
          onRegenerate={handleReviewRegenerate}
        />
      ) : (
        <RecordingPill
          state={state}
          modeName={modeName}
          controller={controllerRef.current}
          error={error}
          errorTitle={errorPresentation?.title}
          privacy={privacy}
          partialText={partialText}
        />
      )}
    </div>
  );
}
