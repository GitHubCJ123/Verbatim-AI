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
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { RecordingPill } from "../components/recording/RecordingPill";
import { startRecording, type AudioController } from "../lib/audio";
import type { RecordingState } from "../lib/store/useRecording";

export default function Overlay() {
  const [state, setState] = useState<RecordingState>("idle");
  const [modeName, setModeName] = useState("Default");
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AudioController | null>(null);

  const start = async (mode: string) => {
    setError(null);
    setModeName(mode);
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

  const stop = async () => {
    const c = controllerRef.current;
    controllerRef.current = null;
    if (!c) {
      setState("idle");
      return;
    }
    setState("processing");
    await c.stop();
    // Mock the pipeline: processing -> polishing -> success -> idle.
    setTimeout(() => setState("polishing"), 600);
    setTimeout(() => setState("success"), 1400);
    setTimeout(() => {
      setState("idle");
      void hideAfter(0);
    }, 2000);
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
    const offStart = listen<{ modeName?: string }>("recording:start", (e) => {
      void start(e.payload?.modeName ?? "Default");
    });
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
