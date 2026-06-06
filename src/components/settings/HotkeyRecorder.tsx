/**
 * HotkeyRecorder — focusable widget that captures a keyboard
 * combination from the user and returns its Tauri shortcut spec
 * string (e.g. "CommandOrControl+Space", "Alt+F1").
 *
 * Build-up UX: modifiers appear in the field as soon as you press them.
 * Press a non-modifier next to commit. Click again to start over.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Kbd } from "../ui/Kbd";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import { applyHotkey, clearHotkey } from "../../lib/hotkey";

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

// Function keys (F1–F24) are safe to bind on their own: unlike a bare
// letter or digit they don't collide with ordinary typing, so we allow
// them as single-key global shortcuts on every platform.
function isFunctionKey(key: string): boolean {
  return /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key);
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
        if (all.size === 0 && !IS_MAC && !isFunctionKey(mainKey)) {
          // No modifier — only function keys (e.g. F6) are safe as a
          // standalone global shortcut on non-macOS. Keep recording for
          // any other bare key so we don't hijack ordinary typing.
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

  return (
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
              {IS_MAC ? "Press a key or shortcut…" : "Press a shortcut or function key…"}
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
    </div>
  );
}
