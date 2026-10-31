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
import { finalizeCleanup, sanitizeTranscript } from "../lib/transcriptQuality";
import {
  isLightCleanupMode,
  looksClean,
  prepareForCleanup,
  resolveCleanupLanguage,
} from "../lib/ai/cleanupPrepass";
import { getPrivacyStatus, type DataLocality } from "../lib/privacyStatus";
import { classifyRecordingError, type RecordingErrorPresentation } from "../lib/recordingErrors";
import {
  deliveryId,
  relayDelivery,
  RecordingDeliveryError,
  type RecordingDeliveryResult,
} from "../lib/recordingDelivery";
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

// Notices shown in the review editor when it appears as a paste-recovery
// surface rather than a deliberate review Mode. They explain *why* it
// popped up so it never feels broken/mysterious.
const REVIEW_PERMISSION_NOTICE =
  "Couldn't paste — Verbatim AI needs Accessibility. Grant it in System Settings → " +
  "Privacy & Security → Accessibility, then relaunch. Use Copy to grab your text meanwhile.";
const REVIEW_ACTIVATION_NOTICE =
  "Couldn't switch back to your app to paste. Use Copy, then paste it where you want.";
const REVIEW_NO_TARGET_NOTICE = "No target to paste into. Use Copy, then paste it where you want.";

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
  // When the review editor appears as a paste-recovery surface, this
  // explains why; `reviewNeedsAccessibility` adds an Open Settings action.
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const [reviewNeedsAccessibility, setReviewNeedsAccessibility] = useState(false);
  const [successLabel, setSuccessLabel] = useState<"Pasted" | "Copied">("Pasted");
  const [reviewBusy, setReviewBusy] = useState(false);
  const reviewBusyRef = useRef(false);
  const completedReviewActionRef = useRef<"Pasted" | "Copied" | null>(null);
  const reviewOpenRef = useRef(false);
  const availableTextRef = useRef("");
  const resultRef = useRef<RecordingDeliveryResult | null>(null);

  const controllerRef = useRef<AudioController | null>(null);
  const stoppingRef = useRef(false);
  // Show the macOS Accessibility system prompt at most once per overlay
  // lifetime. The prompt both asks for the grant AND registers the app in
  // the Accessibility list — without it a clean TCC state leaves nothing to
  // enable, since our preflight uses the *silent* AXIsProcessTrusted check
  // and enigo's own prompt is disabled.
  const axPromptedRef = useRef(false);
  const autoStopRef = useRef<AutoStopDetector | null>(null);
  const partialSegmenterRef = useRef<PartialSegmenter | null>(null);
  const partialCoordinatorRef = useRef<TranscriptionCoordinator<
    PartialTranscriptionPayload,
    string
  > | null>(null);
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
    setReviewNotice(null);
    setReviewNeedsAccessibility(false);
    reviewOpenRef.current = false;
    availableTextRef.current = "";
    resultRef.current = null;
    try {
      await resizeOverlayToPill();
    } catch {
      console.warn("[Verbatim AI] couldn't resize the overlay pill");
    }
    await clearCapturedTarget();
    await hideAfter(0);
  };

  /** Open the macOS Accessibility settings pane (best-effort). */
  const openAccessibilitySettings = () => {
    void invoke("open_accessibility_settings").catch(() => {});
  };

  /**
   * Show the macOS Accessibility prompt once. This registers the app in the
   * Accessibility list (so there's an entry to enable) and asks for the
   * grant. Deduped so repeated dictations while unpermitted don't re-prompt.
   */
  const promptAccessibilityOnce = () => {
    if (axPromptedRef.current) return;
    axPromptedRef.current = true;
    void invoke("request_accessibility_permission").catch(() => {});
  };

  /**
   * Switch the overlay into the review editor. Unlike the recording pill,
   * the review panel is interactive (editable textarea + Cmd+Enter / Esc),
   * so it must take keyboard focus — the overlay window is created
   * `focus: false`, so without this the textarea can't be typed into and
   * the panel feels broken.
   */
  const enterReview = async () => {
    cancelPendingHide();
    reviewOpenRef.current = true;
    setView("review");
    try {
      await resizeOverlayToReview();
    } catch {
      setReviewNotice("Couldn't resize Review. Your text is still here; use Copy.");
    }
    try {
      await getCurrentWindow().setFocus();
    } catch {
      /* best-effort — panel is still usable via mouse */
    }
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
          pcm: payload.pcm,
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
    if (reviewOpenRef.current || stoppingRef.current) {
      if (sessionId)
        await emit("recording:error", {
          sessionId,
          message: "Finish the current dictation or Review before starting another recording.",
        }).catch(() =>
          console.warn("[Verbatim AI] couldn't reject recording while Review is open"),
        );
      return;
    }
    cancelPendingHide();
    setError(null);
    setErrorPresentation(null);
    setStreamingCleaned("");
    setRawText("");
    setPartialText("");
    partialTextRef.current = "";
    availableTextRef.current = "";
    resultRef.current = null;
    setReviewNotice(null);
    setReviewNeedsAccessibility(false);
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

  const runCleanup = async (
    raw: string,
    activeMode: Mode,
    vocab: string[],
    language: string | undefined,
  ): Promise<string> => {
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
      lightCleanup: isLightCleanupMode(activeMode),
      language,
    })) {
      acc += chunk;
      setStreamingCleaned(acc);
    }
    return acc;
  };

  const publishResult = async (payload: RecordingDeliveryResult) => {
    resultRef.current = payload;
    await relayDelivery("recording:result", payload);
  };

  const finishDelivery = (action: "Pasted" | "Copied") => {
    setSuccessLabel(action);
    setState("success");
    const request = ++hideRequestRef.current;
    setTimeout(() => {
      if (request === hideRequestRef.current) void reset();
    }, 900);
  };

  const recoverFailure = async (
    failure: unknown,
    durationMs = 0,
    partial = false,
    capture = false,
  ) => {
    const presentation: RecordingErrorPresentation =
      failure instanceof RecordingDeliveryError
        ? {
            kind: "unknown",
            title: "Delivery needs attention",
            message: failure.message,
            persistent: true,
          }
        : capture
          ? {
              kind: "recording",
              title: "Recording couldn't finish",
              message: "Capture failed. Check your microphone before recording again.",
            }
          : classifyRecordingError(failure);
    void invoke("relay_event", {
      name: "recording:error",
      payload: presentation,
    }).catch(() => console.warn("[Verbatim AI] couldn't relay recording error"));
    const text = sanitizeTranscript(availableTextRef.current);
    if (text) {
      setStreamingCleaned(text);
      setRawText(resultRef.current?.raw ?? text);
      setReviewNotice(
        `${resultRef.current?.outputAction === "pasted" ? "Pasted, but " : ""}${presentation.message} ${partial ? "This is an incomplete live preview, not a final transcript." : "Your available text is below."}${resultRef.current?.outputAction === "pasted" ? " Don't Paste again unless you want another copy." : " Use Copy or try Paste."}`,
      );
      await enterReview();
      const activeMode = modeRef.current;
      const payload: RecordingDeliveryResult = {
        ...(resultRef.current ?? {
          raw: text,
          cleaned: text,
          durationMs,
          language: "auto",
          modeName: activeMode?.name ?? "Default",
          modeId: activeMode?.id ?? null,
          saveHistory: activeMode?.saveHistory ?? false,
        }),
        emitId: deliveryId(),
        outputStyle: "review",
      };
      try {
        await publishResult(payload);
      } catch {
        setReviewNotice(
          `${payload.outputAction === "pasted" ? "Pasted, but " : ""}the main window couldn't confirm this result. Your text is only in this Review window; Copy it before closing.${payload.outputAction === "pasted" ? " Don't Paste again unless you want another copy." : ""}`,
        );
      }
      setState("idle");
      return;
    }
    setErrorPresentation(presentation);
    setError(presentation.message);
    setState("error");
    if (presentation.persistent) cancelPendingHide();
    else void hideAfter(3500);
  };

  const runPipeline = async (
    audio: Blob,
    durationMs: number,
    mode: string,
    capturedPcm?: Float32Array,
  ) => {
    const provider = getActiveProvider(modeRef.current);
    if (!provider) {
      await recoverFailure(
        new Error("No transcription provider is ready. Configure a local model in Settings."),
        durationMs,
        true,
      );
      return;
    }
    const activeMode = modeRef.current ?? getDefaultMode();
    if (!activeMode) {
      await recoverFailure(
        new Error("No Modes available. Create or select a Mode."),
        durationMs,
        true,
      );
      return;
    }
    const vocabularyAll = loadVocabulary();
    const vocabularyTerms = vocabularyAll.map((t) => t.term);

    // Post-hoc VAD silence trim (Phase 4a). Runs before transcription to
    // drop leading/trailing silence and pure-noise clips. Fails open: any
    // decode/trim error falls back to the original audio untouched.
    // Native capture already hands us 16 kHz PCM; keep it alongside the blob
    // so on-device engines never re-decode audio (no AudioContext on the hot
    // path).
    let audioForTranscribe = audio;
    let pcmForTranscribe = capturedPcm;
    if (isSilenceTrimEnabled()) {
      try {
        const pcm = capturedPcm ?? (await decodeToMonoF32_16k(audio));
        pcmForTranscribe = pcm;
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
          pcmForTranscribe = trim.pcm;
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
        pcm: pcmForTranscribe,
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
      // Always-on ASR hygiene: drop "[BLANK_AUDIO]"-style annotations,
      // subtitle hallucinations and decoder repetition loops.
      const sanitized = sanitizeTranscript(transcript.text);
      if (!sanitized) {
        // Only noise was recognized — nothing to paste.
        void reset();
        return;
      }
      const processedText = applyInlinePostProcessing(sanitized, {
        fillerFilter: isFillerFilterEnabled(),
        fuzzyVocab: isFuzzyVocabEnabled(),
        vocabularyTerms: vocabularyAll,
      });
      if (!processedText.trim()) {
        void reset();
        return;
      }

      setRawText(processedText);
      availableTextRef.current = processedText;

      // Branch on output style BEFORE polishing so review users see
      // tokens stream into the editor in real time.
      if (activeMode.outputStyle === "review") {
        await enterReview();
      }

      let cleaned: string;
      const light = isLightCleanupMode(activeMode);
      const language = resolveCleanupLanguage(transcript.languageDetected, processedText);
      const prepared = light ? prepareForCleanup(processedText, language) : processedText;
      if (activeMode.skipCleanup || isAiImproveDisabled() || (light && looksClean(prepared))) {
        // Fast path: skip the LLM entirely; vocab replacements still run.
        cleaned = applyVocabReplacements(prepared, vocabularyAll);
        availableTextRef.current = cleaned;
        setStreamingCleaned(cleaned);
      } else {
        setState("polishing");
        let streamed: string;
        try {
          streamed = await runCleanup(prepared, activeMode, vocabularyTerms, language);
        } catch (e) {
          // Keep the dictation: show it unpolished in the editor with the reason.
          cleaned = applyVocabReplacements(prepared, vocabularyAll);
          setStreamingCleaned(cleaned);
          setReviewNotice(
            `AI polish didn't finish (${e instanceof Error ? e.message : String(e)}). This is your transcript without it.`,
          );
          await enterReview();
          await publishResult({
            emitId: deliveryId(),
            raw: transcript.text,
            cleaned,
            durationMs,
            language: transcript.languageDetected,
            modeName: mode,
            modeId: activeMode.id,
            outputStyle: "review" as const,
            saveHistory: activeMode.saveHistory,
          });
          setState("idle");
          return;
        }
        // Strip chat wrapper text, and fall back to the transcript if the
        // model answered/continued the dictation instead of editing it.
        const { text: cleanedRaw } = finalizeCleanup(prepared, streamed, {
          translating: !!activeMode.targetLanguage,
        });
        cleaned = applyVocabReplacements(cleanedRaw, vocabularyAll);
        if (cleaned !== streamed) setStreamingCleaned(cleaned);
      }

      // Transcript content is only ever logged in dev builds — release
      // builds must not emit dictation content to any console/log
      // (docs/improvement-plan/05-security-privacy.md, F1).
      if (import.meta.env.DEV) {
        console.info("[Verbatim AI] raw:", transcript.text);
        console.info("[Verbatim AI] cleaned:", cleaned);
      }
      availableTextRef.current = cleaned;
      const payload: RecordingDeliveryResult = {
        emitId: deliveryId(),
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
        const outcome = await pasteCleanedText(cleaned);
        if (outcome === "pasted") {
          await publishResult({ ...payload, outputAction: "pasted" });
          finishDelivery("Pasted");
          return;
        }

        const permissionIssue = outcome === "permission-required";
        if (shouldShowReviewWhenPasteMisses() || permissionIssue || outcome === "failed") {
          // Under these output behaviors the text is NOT on the clipboard,
          // so open the recovery editor with a notice explaining why it
          // appeared (so it never feels like a mystery/broken pop-up).
          setReviewNotice(
            outcome === "permission-required"
              ? REVIEW_PERMISSION_NOTICE
              : outcome === "activation-failed"
                ? REVIEW_ACTIVATION_NOTICE
                : outcome === "failed"
                  ? "Couldn't paste. Your text is still here; use Copy or try Paste again."
                  : REVIEW_NO_TARGET_NOTICE,
          );
          setReviewNeedsAccessibility(permissionIssue);
          if (permissionIssue) promptAccessibilityOnce();
          console.info(noPasteTargetMessage());
          await enterReview();
          await publishResult({
            ...payload,
            outputStyle: "review",
            outputAction: shouldShowReviewWhenPasteMisses() ? undefined : "copied",
          });
          setState("idle");
          return;
        }

        // Clipboard behaviors: the cleaned text is already on the clipboard.
        // Genuine miss (or activation failure) with the text on the
        // clipboard — record it as "copied" (not "pasted") since it never
        // reached the target app.
        await publishResult({ ...payload, outputAction: "copied" });
        console.info(noPasteTargetMessage());
        finishDelivery("Copied");
      } else {
        await publishResult(payload);
        // Review panel stays open until user acts.
        setState("idle");
      }
    } catch (e) {
      await recoverFailure(
        e,
        durationMs,
        !resultRef.current && availableTextRef.current === partialTextRef.current,
      );
    }
  };

  const stop = async () => {
    if (stoppingRef.current || reviewOpenRef.current) return;
    stoppingRef.current = true;
    try {
      availableTextRef.current = partialTextRef.current;
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
        } catch (e) {
          await recoverFailure(e, 0, true, true);
          return;
        }
      }
      if (!c) {
        void reset();
        return;
      }
      setState("processing");
      try {
        const result = await c.stop();
        if (!result || result.durationMs < 300) {
          // Accidental tap — nothing worth transcribing.
          void reset();
          return;
        }
        await runPipeline(
          result.blob,
          result.durationMs,
          modeRef.current?.name ?? modeName,
          result.pcm,
        );
      } catch (e) {
        await recoverFailure(e, 0, true, true);
      }
    } finally {
      stoppingRef.current = false;
    }
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

  const reviewAction = async (label: string, action: () => Promise<void>) => {
    if (reviewBusyRef.current) return;
    reviewBusyRef.current = true;
    completedReviewActionRef.current = null;
    setReviewBusy(true);
    try {
      await action();
    } catch (error) {
      const completed = completedReviewActionRef.current;
      setReviewNotice(
        completed
          ? `${completed}, but ${error instanceof RecordingDeliveryError ? error.message : "the result couldn't be confirmed."} Don't Paste again unless you want another copy.`
          : `${label} didn't finish. Your text is still here; try again or use Copy.`,
      );
    } finally {
      reviewBusyRef.current = false;
      setReviewBusy(false);
    }
  };

  const handleReviewPaste = async (text: string) =>
    reviewAction("Paste", async () => {
      const outcome = await pasteCleanedText(text);
      if (outcome === "permission-required") {
        // Keep the panel open so the user can still Copy the text; update the
        // notice and expose an Open Settings action instead of resolving.
        setReviewNotice(REVIEW_PERMISSION_NOTICE);
        setReviewNeedsAccessibility(true);
        promptAccessibilityOnce();
        return;
      }
      if (outcome === "activation-failed") {
        setReviewNotice(REVIEW_ACTIVATION_NOTICE);
        setReviewNeedsAccessibility(false);
        return;
      }
      if (outcome === "failed") {
        setReviewNotice("Couldn't paste. Your text is still here; use Copy or try Paste again.");
        return;
      }
      if (outcome !== "pasted" && shouldShowReviewWhenPasteMisses()) {
        setReviewNotice(REVIEW_NO_TARGET_NOTICE);
        console.info(noPasteTargetMessage());
        return;
      }
      completedReviewActionRef.current = outcome === "pasted" ? "Pasted" : "Copied";
      const payload = {
        emitId: deliveryId(),
        action: outcome === "pasted" ? ("pasted" as const) : ("copied" as const),
        cleaned: text,
        modeId: modeRef.current?.id ?? null,
        result: resultRef.current ?? undefined,
      };
      await relayDelivery("recording:reviewed", payload);
      void reset();
    });

  const handleReviewCopy = async (text: string) =>
    reviewAction("Copy", async () => {
      await copyCleanedText(text);
      completedReviewActionRef.current = "Copied";
      const payload = {
        emitId: deliveryId(),
        action: "copied" as const,
        cleaned: text,
        modeId: modeRef.current?.id ?? null,
        result: resultRef.current ?? undefined,
      };
      await relayDelivery("recording:reviewed", payload);
      void reset();
    });

  const handleReviewDiscard = async () =>
    reviewAction("Discard", async () => {
      const payload = {
        emitId: deliveryId(),
        action: "discarded" as const,
        cleaned: streamingCleaned,
        modeId: modeRef.current?.id ?? null,
        result: resultRef.current ?? undefined,
      };
      try {
        await relayDelivery("recording:reviewed", payload);
      } finally {
        // Discard is explicit: don't trap unwanted text in a failed-history loop.
        void reset();
      }
    });

  const handleReviewRegenerate = async () => {
    if (reviewBusyRef.current) return;
    const activeMode = modeRef.current ?? getDefaultMode();
    if (!activeMode) return;
    const vocabAll = loadVocabulary();
    const vocab = vocabAll.map((t) => t.term);
    setState("polishing");
    try {
      const streamed = await runCleanup(
        rawText,
        activeMode,
        vocab,
        resolveCleanupLanguage(null, rawText),
      );
      const { text: cleanedRaw } = finalizeCleanup(rawText, streamed, {
        translating: !!activeMode.targetLanguage,
      });
      const cleaned = applyVocabReplacements(cleanedRaw, vocabAll);
      availableTextRef.current = cleaned;
      if (cleaned !== streamed) setStreamingCleaned(cleaned);
      setState("idle");
    } catch (e) {
      setStreamingCleaned(availableTextRef.current || rawText);
      setReviewNotice(
        `Regenerate didn't finish (${e instanceof Error ? e.message : String(e)}). Your previous text is still here; use Copy or try again.`,
      );
      setState("idle");
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
          // The bridge re-emits until we ack; ignore duplicate deliveries and
          // any stale retry from an older, superseded session so it can't
          // clobber a newer recording.
          if (sessionId !== 0 && sessionId <= handledSessionRef.current) return;
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
          isPolishing={state === "polishing" || state === "processing"}
          isBusy={reviewBusy}
          notice={reviewNotice}
          onOpenSettings={reviewNeedsAccessibility ? openAccessibilitySettings : undefined}
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
          successLabel={successLabel}
        />
      )}
    </div>
  );
}
