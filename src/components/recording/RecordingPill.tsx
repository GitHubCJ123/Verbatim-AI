import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Mic, Loader2, Sparkles, Check, AlertCircle } from "lucide-react";
import { Waveform } from "./Waveform";
import type { AudioController } from "../../lib/audio";
import type { RecordingState } from "../../lib/store/useRecording";
import { cn } from "../../lib/utils";

interface RecordingPillProps {
  state: RecordingState;
  modeName: string;
  /** Live audio controller when state === "recording". */
  controller?: AudioController | null;
  /** Optional error message for the error state. */
  error?: string | null;
}

function formatDuration(ms: number) {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function useElapsed(active: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      setElapsed(0);
      return;
    }
    startedAt.current = performance.now();
    let raf = 0;
    const tick = () => {
      if (startedAt.current != null) setElapsed(performance.now() - startedAt.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return elapsed;
}

export function RecordingPill({ state, modeName, controller, error }: RecordingPillProps) {
  const elapsed = useElapsed(state === "recording");

  // Stable getter for the waveform that survives controller swaps.
  const controllerRef = useRef<AudioController | null>(null);
  controllerRef.current = controller ?? null;
  const getBars = () => controllerRef.current?.getBars(32) ?? new Array(32).fill(0);

  return (
    <AnimatePresence>
      {state !== "idle" && (
        <motion.div
          key="pill"
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.96 }}
          transition={{ type: "spring", stiffness: 240, damping: 26 }}
          className={cn(
            "pointer-events-auto relative flex h-[72px] w-[360px] items-center gap-3 overflow-hidden rounded-pill border px-4",
            "shadow-md backdrop-blur-2xl",
            state === "error"
              ? "border-danger/40 bg-danger/10"
              : "border-white/10 bg-[rgba(20,20,28,0.65)]",
          )}
        >
          {/* Accent ring on left */}
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center">
            {state === "recording" && (
              <motion.span
                className="absolute inset-0 rounded-pill border border-accent-solid/40"
                animate={{ scale: [1, 1.25, 1], opacity: [0.6, 0, 0.6] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
              />
            )}
            <div
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-pill",
                state === "error"
                  ? "bg-danger/20 text-danger"
                  : state === "success"
                    ? "bg-success/20 text-success"
                    : "bg-gradient-to-br from-accent-start to-accent-end text-white",
              )}
            >
              {state === "error" ? (
                <AlertCircle className="h-4 w-4" />
              ) : state === "success" ? (
                <Check className="h-4 w-4" strokeWidth={3} />
              ) : state === "polishing" ? (
                <Sparkles className="h-4 w-4" />
              ) : state === "processing" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Mic className="h-4 w-4" strokeWidth={2.25} />
              )}
            </div>
          </div>

          {/* Center: waveform or shimmer */}
          <div className="relative flex h-10 flex-1 items-center">
            {state === "recording" && (
              <Waveform getBars={getBars} className="h-full w-full" />
            )}
            {(state === "processing" || state === "polishing") && (
              <div className="relative h-1 w-full overflow-hidden rounded-pill bg-white/[0.06]">
                <motion.div
                  className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-accent-start to-transparent"
                  animate={{ x: ["-100%", "300%"] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
                />
              </div>
            )}
            {state === "success" && (
              <div className="text-sm font-medium text-success">Done</div>
            )}
            {state === "error" && (
              <div className="truncate text-xs text-danger">{error ?? "Something went wrong"}</div>
            )}
          </div>

          {/* Right meta */}
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <div className="font-mono text-xs tabular-nums text-text-primary">
              {state === "recording" ? formatDuration(elapsed) : ""}
            </div>
            <div className="max-w-[110px] truncate text-[10px] text-text-muted">{modeName}</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
