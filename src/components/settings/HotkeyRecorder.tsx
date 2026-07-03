/**
 * HotkeyRecorder — focusable widget that captures a keyboard
 * combination from the user and returns its Tauri shortcut spec
 * string (e.g. "CommandOrControl+Space", "Alt+F1").
 *
 * Build-up UX: modifiers appear in the field as soon as you press them.
 * Press a non-modifier next to commit. Click again to start over.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Kbd } from "../ui/Kbd";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import { applyHotkey, clearHotkey } from "../../lib/hotkey";
import { toast } from "../ui/Toast";

interface HotkeyRecorderProps {
  value: string;
  onChange: (spec: string) => void;
}

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const MODIFIER_LABEL: Record<string, string> = IS_MAC
  ? {
      CommandOrControl: "⌘",
      Control: "⌃",
      Shift: "⇧",
      Alt: "⌥",
      Super: "⌘",
      Fn: "fn",
    }
  : {
      CommandOrControl: "Ctrl",
      Control: "Ctrl",
      Shift: "Shift",
      Alt: "Alt",
      Super: "Win",
    };

function parts(spec: string): string[] {
  return spec.split("+").map((p) => p.trim()).filter(Boolean);
}

// Returns the canonical modifier name for this key event, or null if
// it's not a modifier.
function modifierFromEvent(e: KeyboardEvent): string | null {
  if (e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight") return "Control";
  if (e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight") return "Shift";
  if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") return "Alt";
  if (e.key === "Meta" || e.key === "OS" || e.code === "MetaLeft" || e.code === "MetaRight") return "Super";
  return null;
}

// Returns the canonical main-key name (non-modifier) or null.
function mainKeyFromEvent(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key === " " || e.code === "Space") return "Space";
  if (e.code?.startsWith("Arrow")) return e.code.replace("Arrow", "");
  if (key.length === 1) return key.toUpperCase();
  if (key.startsWith("Arrow")) return key.replace("Arrow", "");
  if (key === "Escape" || key === "Tab" || key === "Enter" || key === "Backspace") return null;
  // Function keys (F1, F12, etc.) come through as multi-char e.key.
  if (key.length > 1) return key;
  return null;
}

export function HotkeyRecorder({ value, onChange }: HotkeyRecorderProps) {
  const [recording, setRecording] = useState(false);
  // Pending modifiers accumulated as the user presses keys.
  const [pendingMods, setPendingMods] = useState<string[]>([]);
  const [committed, setCommitted] = useState<string | null>(null);
  const committedRef = useRef<string | null>(null);

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecording(false);
        setPendingMods([]);
        setCommitted(null);
        committedRef.current = null;
        return;
      }

      // Modifier key pressed — add to pending list (if not already there).
      const mod = modifierFromEvent(e);
      if (mod) {
        setPendingMods((mods) => (mods.includes(mod) ? mods : [...mods, mod]));
        return;
      }

      // Non-modifier — commit if we have at least one modifier. On macOS,
      // single-key press-and-hold is allowed for push-to-talk.
      const mainKey = mainKeyFromEvent(e);
      if (!mainKey) return;

      // Pull mods from BOTH the event state (e.ctrlKey etc.) and the
      // accumulated pending list — Windows IME / global hotkeys may
      // strip the modifier flag from a follow-up keystroke.
      setPendingMods((accumulated) => {
        const all = new Set<string>(accumulated);
        if (e.ctrlKey) all.add("Control");
        if (e.metaKey) all.add("Super");
        if (e.shiftKey) all.add("Shift");
        if (e.altKey) all.add("Alt");
        if (all.size === 0 && !IS_MAC) {
          // No modifier — not a valid global shortcut on non-macOS. Keep recording.
          return accumulated;
        }
        const spec = all.size === 0 ? mainKey : [...all, mainKey].join("+");
        committedRef.current = spec;
        setCommitted(spec);
        setRecording(false);
        onChange(spec);
        return [];
      });
    },
    [recording, onChange],
  );

  useEffect(() => {
    if (!recording) return;
    window.addEventListener("keydown", handleKey, true);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      // Re-register whatever the user committed (or fall back to what
      // they had before they opened the recorder).
      const spec = committedRef.current ?? value;
      if (spec) void applyHotkey(spec).catch(() => {});
    };
  }, [recording, handleKey, value]);

  const displayed = committed ?? value;
  const tokens = recording && pendingMods.length > 0 ? pendingMods : parts(displayed);

  // The fn key never produces a keydown in the WebView, so it can't be
  // captured by the recorder — it gets an explicit chip instead. The
  // Rust side runs a flags-changed event tap for it (fn_hotkey.rs) and
  // needs the Input Monitoring permission.
  const useFnKey = async () => {
    try {
      await applyHotkey("Fn");
      committedRef.current = "Fn";
      setCommitted("Fn");
      setRecording(false);
      setPendingMods([]);
      onChange("Fn");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("needs-input-monitoring")) {
        toast.error("Input Monitoring permission needed", {
          description:
            "Enable Verbatim AI under System Settings → Privacy & Security → " +
            "Input Monitoring (opening now), then relaunch the app and pick fn again.",
        });
        void invoke("open_input_monitoring_settings").catch(() => {});
      } else {
        toast.error("Couldn't enable the fn key", { description: msg });
      }
    }
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={async () => {
          // Free the active global shortcut so its keys reach the
          // recorder instead of triggering the recording pipeline.
          try {
            await clearHotkey();
          } catch {
            /* ignore */
          }
          setPendingMods([]);
          setCommitted(null);
          committedRef.current = null;
          setRecording(true);
        }}
        className={cn(
          "flex h-9 min-w-[160px] items-center justify-center gap-1 rounded-md border px-3 transition-colors",
          recording
            ? "border-accent-solid/60 bg-accent-solid/10 text-accent-start"
            : "border-border-subtle bg-bg-base text-text-primary hover:border-border-strong",
        )}
      >
        {tokens.length === 0 ? (
          recording ? (
            <span className="text-xs text-text-secondary">
              {IS_MAC ? "Press a key or shortcut…" : "Press your shortcut…"}
            </span>
          ) : (
            <span className="text-xs text-text-muted">No shortcut</span>
          )
        ) : (
          <>
            {tokens.map((t, i) => (
              <Kbd key={i}>{MODIFIER_LABEL[t] ?? t}</Kbd>
            ))}
            {recording && (
              <span className="ml-1 text-xs text-text-muted">+ key…</span>
            )}
          </>
        )}
      </button>
      {recording && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setRecording(false);
            setPendingMods([]);
            committedRef.current = null;
          }}
        >
          Cancel
        </Button>
      )}
        {IS_MAC && !recording && displayed !== "Fn" && (
          <button
            type="button"
            onClick={() => void useFnKey()}
            className="flex h-9 items-center gap-1 rounded-md border border-border-subtle bg-bg-elevated px-3 text-xs text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
            title="Use the fn key alone — hold to talk"
          >
            Use <Kbd>fn</Kbd>
          </button>
        )}
      </div>
      {IS_MAC && displayed === "Fn" && (
        <p className="max-w-[260px] text-right text-[11px] leading-snug text-text-muted">
          Hold <Kbd>fn</Kbd> to talk. If pressing it opens the emoji picker,
          set System Settings → Keyboard → "Press 🌐 key to" → Do Nothing.
        </p>
      )}
    </div>
  );
}
