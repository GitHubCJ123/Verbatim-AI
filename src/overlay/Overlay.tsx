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
import { emit, listen } from "@tauri-apps/api/event";
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
import type { Mode } from "../types/mode";

type View = "pill" | "review";

export default function Overlay() {
  const [state, setState] = useState<RecordingState>("idle");
  const [view, setView] = useState<View>("pill");
  const [modeName, setModeName] = useState("Default");
  const [error, setError] = useState<string | null>(null);
  const [streamingCleaned, setStreamingCleaned] = useState("");
  const [rawText, setRawText] = useState("");

  const controllerRef = useRef<AudioController | null>(null);
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

  const start = async (mode: string, modeId: string | null) => {
    setError(null);
    setStreamingCleaned("");
    setRawText("");
    setView("pill");
    setModeName(mode);
    modeRef.current = getModeById(modeId) ?? getDefaultMode();
    try {
      const w = getCurrentWindow();
      await w.show();
      controllerRef.current = await startRecording({
        onError: (e) => {
          setError(e.message);
          setState("error");
        },
      });
      setState("recording");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setState("error");
      void hideAfter(2500);
    }
  };

  const runCleanup = async (raw: string, activeMode: Mode, vocab: string[]): Promise<string> => {
    const provider = getActiveProvider();
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
    const provider = getActiveProvider();
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
      setRawText(transcript.text);

      // Branch on output style BEFORE polishing so review users see
      // tokens stream into the editor in real time.
      if (activeMode.outputStyle === "review") {
        await resizeOverlayToReview();
        setView("review");
      }

      let cleaned: string;
      if (activeMode.skipCleanup) {
        // Fast path: skip the LLM entirely; vocab replacements still run.
        cleaned = applyVocabReplacements(transcript.text, vocabularyAll);
        setStreamingCleaned(cleaned);
      } else {
        setState("polishing");
        const cleanedRaw = await runCleanup(transcript.text, activeMode, vocabularyTerms);
        cleaned = applyVocabReplacements(cleanedRaw, vocabularyAll);
        if (cleaned !== cleanedRaw) setStreamingCleaned(cleaned);
      }

      console.info("[Verbatim AI] raw:", transcript.text);
      console.info("[Verbatim AI] cleaned:", cleaned);

      await emit("recording:result", {
        raw: transcript.text,
        cleaned,
        durationMs,
        language: transcript.languageDetected,
        modeName: mode,
        modeId: activeMode.id,
        outputStyle: activeMode.outputStyle,
        saveHistory: activeMode.saveHistory,
      });

      if (activeMode.outputStyle === "paste") {
        const pasted = await pasteCleanedText(cleaned);
        if (!pasted) {
          // No captured target — fall back to clipboard.
          console.info("[Verbatim AI] no paste target; copied to clipboard");
        }
        setState("success");
        setTimeout(() => void reset(), 900);
      } else {
        // Review panel stays open until user acts.
        setState("idle");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Verbatim AI] pipeline error:", e);
      void emit("recording:error", { message: msg, stack: e instanceof Error ? e.stack : undefined });
      setError(msg);
      setState("error");
      void hideAfter(3500);
    }
  };

  const stop = async () => {
    const c = controllerRef.current;
    controllerRef.current = null;
    if (!c) {
      setState("idle");
      return;
    }
    setState("processing");
    const result = await c.stop();
    if (!result) {
      void reset();
      return;
    }
    await runPipeline(result.blob, result.durationMs, modeName);
  };

  // Review panel actions

  const handleReviewPaste = async (text: string) => {
    const ok = await pasteCleanedText(text);
    await emit("recording:reviewed", {
      action: ok ? "pasted" : "copied",
      cleaned: text,
      modeId: modeRef.current?.id ?? null,
    });
    void reset();
  };

  const handleReviewCopy = async (text: string) => {
    await copyCleanedText(text);
    await emit("recording:reviewed", {
      action: "copied",
      cleaned: text,
      modeId: modeRef.current?.id ?? null,
    });
    void reset();
  };

  const handleReviewDiscard = async () => {
    await emit("recording:reviewed", {
      action: "discarded",
      cleaned: streamingCleaned,
      modeId: modeRef.current?.id ?? null,
    });
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
    const offStart = listen<{ modeName?: string; modeId?: string | null }>(
      "recording:start",
      (e) => {
        void start(e.payload?.modeName ?? "Default", e.payload?.modeId ?? null);
      },
    );
    const offStop = listen("recording:stop", () => {
      void stop();
    });
    const offCancel = listen("recording:cancel", () => {
      controllerRef.current?.cancel();
      controllerRef.current = null;
      void reset();
    });
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
        controllerRef.current?.cancel();
        controllerRef.current = null;
        void reset();
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
        />
      )}
    </div>
  );
}
