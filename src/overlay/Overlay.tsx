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
import type { RecordingState } from "../lib/store/useRecording";
import { getActiveProvider } from "../lib/ai";
import { getModeById, getDefaultMode, loadVocabulary } from "../lib/store/useModes";
import { applyVocabReplacements } from "../lib/vocab";
import {
  resizeOverlayToPill,
  resizeOverlayToReview,
} from "../lib/recording-bridge";
import { pasteCleanedText, copyCleanedText, clearCapturedTarget } from "../lib/output";
import {
  isAiImproveDisabled,
  getMicDeviceId,
  getOutputBehavior,
  isPerfDebugEnabled,
  isFillerFilterEnabled,
  isFuzzyVocabEnabled,
} from "../lib/preferences";
import { applyInlinePostProcessing } from "../lib/postProcess";
import { getPrivacyStatus, type DataLocality } from "../lib/privacyStatus";
import type { Mode } from "../types/mode";

function noPasteTargetMessage(): string {
  const behavior = getOutputBehavior();
  if (behavior === "insert-only") {
    return "[Verbatim AI] no paste target; clipboard unchanged because insert-only is enabled";
  }
  if (behavior === "restore") {
    return "[Verbatim AI] no paste target; previous clipboard will be restored";
  }
  return "[Verbatim AI] no paste target; copied to clipboard";
}

type View = "pill" | "review";

export default function Overlay() {
  const [state, setState] = useState<RecordingState>("idle");
  const [view, setView] = useState<View>("pill");
  const [modeName, setModeName] = useState("Default");
  const [error, setError] = useState<string | null>(null);
  const [streamingCleaned, setStreamingCleaned] = useState("");
  const [rawText, setRawText] = useState("");
  const [privacy, setPrivacy] = useState<DataLocality | null>(null);

  const controllerRef = useRef<AudioController | null>(null);
  // In-flight getUserMedia: a stop/cancel that lands while the mic is
  // still being acquired must await this so the stream is never leaked.
  const startingRef = useRef<Promise<AudioController> | null>(null);
  const modeRef = useRef<Mode | null>(null);

  const hideAfter = async (ms: number) => {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    try {
      await getCurrentWindow().hide();
    } catch {
      /* ignore */
    }
  };

  const reset = async () => {
    setState("idle");
    setView("pill");
    setStreamingCleaned("");
    setRawText("");
    setError(null);
    await resizeOverlayToPill();
    await clearCapturedTarget();
    await hideAfter(0);
  };

  const start = async (mode: string, modeId: string | null, pressedAt?: number) => {
    setError(null);
    setStreamingCleaned("");
    setRawText("");
    setView("pill");
    setModeName(mode);
    modeRef.current = getModeById(modeId) ?? getDefaultMode();
    setPrivacy(getPrivacyStatus(modeRef.current).overall);
    try {
      // The bridge shows this window concurrently — don't wait for it.
      // Opening the mic immediately is what keeps the first syllable
      // from being lost (docs/improvement-plan/04-performance-latency.md).
      const starting = startRecording({
        deviceId: getMicDeviceId() || undefined,
        onError: (e) => {
          setError(e.message);
          setState("error");
        },
      });
      startingRef.current = starting;
      const controller = await starting;
      if (startingRef.current === starting) {
        controllerRef.current = controller;
        setState("recording");
        if (pressedAt && isPerfDebugEnabled()) {
          console.info(`[perf] press→listening ${Date.now() - pressedAt}ms`);
        }
      }
      // else: a stop/cancel consumed this start while the mic was
      // being acquired — that path owns the controller now.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setState("error");
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

    try {
      setState("processing");
      const transcript = await provider.transcribe({
        audio,
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
        if (!pasted && getOutputBehavior() !== "copy") {
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
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Verbatim AI] pipeline error:", e);
      void invoke("relay_event", {
        name: "recording:error",
        payload: { message: msg, stack: e instanceof Error ? e.stack : undefined },
      });
      setError(msg);
      setState("error");
      void hideAfter(3500);
    }
  };

  const stop = async () => {
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
    if (!ok && getOutputBehavior() !== "copy") {
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
      setState("error");
    }
  };

  useEffect(() => {
    const offStart = listen<{ modeName?: string; modeId?: string | null; pressedAt?: number }>(
      "recording:start",
      (e) => {
        void start(
          e.payload?.modeName ?? "Default",
          e.payload?.modeId ?? null,
          e.payload?.pressedAt,
        );
      },
    );
    const offStop = listen("recording:stop", () => {
      void stop();
    });
    const offCancel = listen("recording:cancel", () => {
      cancelActive();
    });
    // Tell the main window we're alive so it doesn't drop a
    // recording:start emitted before our listeners attached.
    void emit("overlay:ready");
    return () => {
      void offStart.then((u) => u());
      void offStop.then((u) => u());
      void offCancel.then((u) => u());
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
          privacy={privacy}
        />
      )}
    </div>
  );
}
