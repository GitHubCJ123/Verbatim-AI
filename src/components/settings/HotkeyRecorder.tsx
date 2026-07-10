/**
 * HotkeyRecorder — focusable widget that captures a keyboard
 * combination from the user and returns its Tauri shortcut spec
 * string (e.g. "CommandOrControl+Space", "Alt+F1").
 *
 * Build-up UX: modifiers appear in the field as soon as you press them.
 * Press a non-modifier next to commit. Click again to start over.
 *
 * "Single key" dropdown offers fn, right ⌘ (macOS only), and
 * function keys (all platforms) as a one-click alternative to recording.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Kbd } from "../ui/Kbd";
import { Button } from "../ui/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "../ui/Select";
import { cn } from "../../lib/utils";
import { applyHotkey, clearHotkey, isFunctionKey } from "../../lib/hotkey";
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
      RightCommand: "right ⌘",
    }
  : {
      CommandOrControl: "Ctrl",
      Control: "Ctrl",
      Shift: "Shift",
      Alt: "Alt",
      Super: "Win",
    };

// Function keys offered in the "Single key" dropdown (all platforms).
const FUNCTION_KEYS = [
  "F1", "F2", "F3", "F4", "F5", "F6",
  "F7", "F8", "F9", "F10", "F11", "F12",
];

function parts(spec: string): string[] {
  return spec.split("+").map((p) => p.trim()).filter(Boolean);
}

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
      // single-key press-and-hold is allowed for push-to-talk; on every
      // platform a lone function key (e.g. F6) is allowed as a single-key
      // hotkey.
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
          // No modifier and not a function key — not a usable global
          // shortcut on non-macOS (a bare letter/Space would hijack
          // ordinary typing). Keep recording.
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

  // Shared handler for Input-Monitoring-gated single keys (fn, right ⌘).
  // fn / right ⌘ never produce a keydown in the WebView, so they can't be
  // captured by the recorder — the "Single key" dropdown provides the path.
  // The Rust side runs a flags-changed event tap (fn_hotkey.rs) and needs
  // the Input Monitoring permission.
  const applyInputMonitoringKey = async (spec: string, label: string) => {
    try {
      await applyHotkey(spec);
      committedRef.current = spec;
      setCommitted(spec);
      onChange(spec);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("needs-input-monitoring")) {
        toast.error("Input Monitoring permission needed", {
          description:
            "Enable Verbatim AI under System Settings → Privacy & Security → " +
            `Input Monitoring (opening now), then relaunch the app and pick ${label} again.`,
        });
        void invoke("open_input_monitoring_settings").catch(() => {});
      } else {
        toast.error(`Couldn't enable the ${label} key`, { description: msg });
      }
    }
  };

  const handleSingleKey = async (val: string) => {
    if (!val) return;
    if (val === "Fn") {
      await applyInputMonitoringKey("Fn", "fn");
    } else if (val === "RightCommand") {
      await applyInputMonitoringKey("RightCommand", "right ⌘");
    } else {
      // Plain function key — no special permission needed.
      try {
        await applyHotkey(val);
        committedRef.current = val;
        setCommitted(val);
        onChange(val);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`Couldn't enable ${val}`, { description: msg });
      }
    }
  };

  const displayed = committed ?? value;
  const tokens = recording && pendingMods.length > 0 ? pendingMods : parts(displayed);

  // One concise helper line beneath the controls, appropriate to the
  // current selection. Shown only when there is something useful to say.
  const helperContent =
    displayed === "Fn" ? (
      <p className="max-w-[280px] text-right text-[11px] leading-snug text-text-muted">
        Hold <Kbd>fn</Kbd> to talk · If it opens the emoji picker, set System
        Settings → Keyboard → &ldquo;Press 🌐 key to&rdquo; → Do Nothing.
      </p>
    ) : displayed === "RightCommand" ? (
      <p className="max-w-[280px] text-right text-[11px] leading-snug text-text-muted">
        Hold <Kbd>right ⌘</Kbd> to talk · Input Monitoring required; left ⌘ and
        normal shortcuts are unaffected.
      </p>
    ) : displayed && parts(displayed).length === 1 ? (
      <p className="max-w-[280px] text-right text-[11px] leading-snug text-text-muted">
        Hold to talk.
      </p>
    ) : null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        {/* Primary capture button */}
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
                {IS_MAC
                  ? "Press a key or shortcut…"
                  : "Press a shortcut or function key (e.g. F6)…"}
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

        {recording ? (
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
        ) : (
          // "Single key" dropdown — replaces the two loose "Use fn" /
          // "Use right ⌘" buttons. Offers macOS-specific single keys
          // (fn, right ⌘) and function keys valid on all platforms.
          // value="" keeps the trigger label fixed at "Single key".
          <Select value="" onValueChange={(val) => void handleSingleKey(val)}>
            <SelectTrigger
              className="h-9 w-auto gap-1.5 px-3 text-xs text-text-secondary"
              aria-label="Pick a single key shortcut"
            >
              <span>Single key</span>
            </SelectTrigger>
            <SelectContent>
              {IS_MAC && (
                <>
                  <SelectItem value="Fn">fn — hold to talk</SelectItem>
                  <SelectItem value="RightCommand">right ⌘ — hold to talk</SelectItem>
                </>
              )}
              {FUNCTION_KEYS.map((fk) => (
                <SelectItem key={fk} value={fk}>
                  {fk}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {helperContent}
    </div>
  );
}
