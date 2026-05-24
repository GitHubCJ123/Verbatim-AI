/**
 * Overlay window entry.
 *
 * Lives in a separate Tauri window (transparent, no-decorations,
 * always-on-top, no-activate). It receives a small set of events
 * from the main window to drive its state machine:
 *
 *   recording:start { modeName }
 *   recording:stop
 *   recording:state { state, error? }
 *
 * For Phase 2 we wire the audio capture *inside* the overlay window
 * because the WebAudio APIs are most reliable in the same DOM that
 * needs to render the waveform.
 */
import { useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { RecordingPill } from "../components/recording/RecordingPill";
import { startRecording, type AudioController } from "../lib/audio";
import type { RecordingState } from "../lib/store/useRecording";
import { getActiveProvider } from "../lib/ai";
import { getModeById, getDefaultMode, loadVocabulary } from "../lib/store/useModes";
import type { Mode } from "../types/mode";

export default function Overlay() {
  const [state, setState] = useState<RecordingState>("idle");
  const [modeName, setModeName] = useState("Default");
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AudioController | null>(null);
  const modeRef = useRef<Mode | null>(null);

  const start = async (mode: string, modeId: string | null) => {
    setError(null);
    setModeName(mode);
    // Resolve fresh from storage so edits in the main window are picked up.
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

  const runPipeline = async (audio: Blob, durationMs: number, mode: string) => {
    const provider = getActiveProvider();
    if (!provider) {
      setError("Configure Azure in Settings → AI to enable transcription.");
      setState("error");
      void hideAfter(3500);
      return;
    }
    const activeMode = modeRef.current ?? getDefaultMode();
    const vocabularyTerms = loadVocabulary().map((t) => t.term);
    try {
      setState("processing");
      const transcript = await provider.transcribe({
        audio,
        language: activeMode.language || "auto",
        vocabularyHints: vocabularyTerms,
      });

      setState("polishing");
      let cleaned = "";
      for await (const chunk of provider.cleanup({
        rawText: transcript.text,
        systemPrompt: activeMode.systemPrompt,
        modeName: activeMode.name,
        modeDescription: activeMode.description,
        vocabulary: vocabularyTerms,
        targetLanguage: activeMode.targetLanguage ?? undefined,
      })) {
        cleaned += chunk;
      }

      console.info("[SuperWisper] raw:", transcript.text);
      console.info("[SuperWisper] cleaned:", cleaned);
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

      setState("success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[SuperWisper] pipeline error:", e);
      setError(msg);
      setState("error");
      void hideAfter(3500);
      return;
    }
    setTimeout(() => {
      setState("idle");
      void hideAfter(0);
    }, 1200);
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
      setState("idle");
      void hideAfter(0);
      return;
    }
    await runPipeline(result.blob, result.durationMs, modeName);
  };

  const hideAfter = async (ms: number) => {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    try {
      await getCurrentWindow().hide();
    } catch {
      /* ignore */
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
      setState("idle");
      void hideAfter(0);
    });
    return () => {
      void offStart.then((u) => u());
      void offStop.then((u) => u());
      void offCancel.then((u) => u());
    };
  }, []);

  // Press Esc inside the overlay to cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        controllerRef.current?.cancel();
        controllerRef.current = null;
        setState("idle");
        void hideAfter(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent p-3">
      <RecordingPill
        state={state}
        modeName={modeName}
        controller={controllerRef.current}
        error={error}
      />
    </div>
  );
}
