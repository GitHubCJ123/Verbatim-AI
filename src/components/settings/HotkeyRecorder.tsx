/**
 * HotkeyRecorder — one control that temporarily clears the active global
 * shortcut, then captures either a keyboard combination or a supported
 * single key. On macOS, native capture events add support for bare fn.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Kbd } from "../ui/Kbd";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import {
  applyHotkey,
  clearHotkey,
  isFunctionKey,
  IS_MAC,
} from "../../lib/hotkey";
import { setHotkeyPaused } from "../../lib/preferences";
import { toast } from "../ui/Toast";
import { handleInputMonitoringError } from "./inputMonitoring";

interface HotkeyRecorderProps {
  value: string;
  onChange: (spec: string) => void;
}

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
      RightCommand: "right ⌘",
    };

function parts(spec: string): string[] {
  return spec
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
}

function modifierFromEvent(e: KeyboardEvent): string | null {
  if (e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight") {
    return "Control";
  }
  if (e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight") {
    return "Shift";
  }
  if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
    return "Alt";
  }
  if (
    e.key === "Meta" ||
    e.key === "OS" ||
    e.code === "MetaLeft" ||
    e.code === "MetaRight"
  ) {
    return "Super";
  }
  return null;
}

function mainKeyFromEvent(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key === " " || e.code === "Space") return "Space";
  if (e.code?.startsWith("Arrow")) return e.code.replace("Arrow", "");
  if (key.length === 1) return key.toUpperCase();
  if (key.startsWith("Arrow")) return key.replace("Arrow", "");
  if (key === "Escape" || key === "Tab" || key === "Enter" || key === "Backspace") {
    return null;
  }
  if (key.length > 1) return key;
  return null;
}

interface CaptureCallbacks {
  onRecordingChange: (recording: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onPendingModifiersChange: (modifiers: string[]) => void;
  onReset: () => void;
  onCommit: (spec: string) => void;
  onFnCaptureUnavailable: () => void;
  onUnsupportedKey: (key: string) => void;
  onError: (message: string) => void;
}

/**
 * Owns one capture transaction. Keeping the teardown and event guards here
 * makes native fn events, WebView key events, cancel, and unmount share the
 * same restore path.
 */
export class HotkeyCaptureSession {
  private done = true;
  private prevSpec = "";
  private pendingFn = false;
  private pendingModifiers: string[] = [];
  private unlisteners: UnlistenFn[] = [];
  private clearInFlight: Promise<void> | null = null;
  private nativeStartInFlight: Promise<void> | null = null;
  private cleanupInFlight: Promise<void> | null = null;
  private paused = false;

  constructor(private readonly callbacks: CaptureCallbacks) {}

  private readonly handleKeydown = (e: KeyboardEvent) => {
    if (this.done) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      // cleanup() sets done=true, which blocks any late fn-up from committing.
      void this.cleanup().catch((error) => this.reportError(error));
      return;
    }

    const modifier = modifierFromEvent(e);
    if (modifier) {
      // A lone modifier keydown must NOT cancel a pending bare-fn gesture.
      if (!this.pendingModifiers.includes(modifier)) {
        this.pendingModifiers = [...this.pendingModifiers, modifier];
        this.callbacks.onPendingModifiersChange(this.pendingModifiers);
      }
      return;
    }

    // A real (non-modifier) WebView key means this isn't a bare-fn gesture.
    this.pendingFn = false;

    const mainKey = mainKeyFromEvent(e);
    if (!mainKey) return;

    const allModifiers = new Set(this.pendingModifiers);
    if (e.ctrlKey) allModifiers.add("Control");
    if (e.metaKey) allModifiers.add("Super");
    if (e.shiftKey) allModifiers.add("Shift");
    if (e.altKey) allModifiers.add("Alt");

    // Reject a bare alphanumeric/Space key on ALL platforms: registered as a
    // global shortcut it would hijack that key system-wide. Legitimate
    // single-key hotkeys are function keys (here) and fn / right-⌘ (native).
    if (allModifiers.size === 0 && !isFunctionKey(mainKey)) {
      this.callbacks.onUnsupportedKey(mainKey);
      return;
    }

    const spec =
      allModifiers.size === 0
        ? mainKey
        : [...allModifiers, mainKey].join("+");
    this.callbacks.onUnsupportedKey("");
    void this.commit(spec);
  };

  private readonly handleFnDown = () => {
    if (this.done) return;
    this.pendingFn = true;
  };

  private readonly handleFnUp = () => {
    if (this.done || !this.pendingFn) return;
    this.pendingFn = false;
    void this.commit("Fn");
  };

  async start(prevSpec: string): Promise<void> {
    if (!this.done || this.cleanupInFlight) return;

    this.done = false;
    this.prevSpec = prevSpec;
    this.pendingFn = false;
    this.pendingModifiers = [];
    this.callbacks.onReset();
    this.callbacks.onBusyChange(true);

    const clear = clearHotkey();
    this.clearInFlight = clear;
    try {
      await clear;
    } catch (error) {
      await this.cleanup().catch(() => {});
      this.reportError(error);
      return;
    } finally {
      if (this.clearInFlight === clear) this.clearInFlight = null;
    }

    // Cancel/unmount may have arrived while clear_hotkey was in flight.
    if (this.done) return;

    try {
      setHotkeyPaused(true);
      this.paused = true;
      window.addEventListener("keydown", this.handleKeydown, true);
      this.callbacks.onRecordingChange(true);
      this.callbacks.onBusyChange(false);
    } catch (error) {
      await this.cleanup().catch(() => {});
      this.reportError(error);
      return;
    }

    if (!IS_MAC) return;

    let subscriptions: UnlistenFn[];
    try {
      subscriptions = await Promise.all([
        listen("hotkey-capture:fn-down", this.handleFnDown),
        listen("hotkey-capture:fn-up", this.handleFnUp),
      ]);
    } catch {
      if (!this.done) this.callbacks.onFnCaptureUnavailable();
      return;
    }
    if (this.done) {
      subscriptions.forEach((unlisten) => unlisten());
      return;
    }
    this.unlisteners.push(...subscriptions);

    const nativeStart = invoke<void>("start_hotkey_capture");
    this.nativeStartInFlight = nativeStart;
    try {
      await nativeStart;
    } catch {
      if (!this.done) this.callbacks.onFnCaptureUnavailable();
    } finally {
      if (this.nativeStartInFlight === nativeStart) {
        this.nativeStartInFlight = null;
      }
    }
  }

  async cleanup(committedSpec?: string): Promise<void> {
    if (this.cleanupInFlight) return this.cleanupInFlight;
    if (this.done && !this.clearInFlight && !this.paused) return;

    this.done = true;
    this.pendingFn = false;
    this.callbacks.onRecordingChange(false);
    this.callbacks.onBusyChange(true);
    this.callbacks.onPendingModifiersChange([]);

    const restoreSpec = committedSpec ?? this.prevSpec;
    const previousSpec = this.prevSpec;
    const pendingClear = this.clearInFlight;
    const pendingNativeStart = this.nativeStartInFlight;

    const cleanup = (async () => {
      let restoreError: unknown = null;
      try {
        await pendingClear?.catch(() => {});
        await pendingNativeStart?.catch(() => {});
      } finally {
        window.removeEventListener("keydown", this.handleKeydown, true);
        this.unlisteners.splice(0).forEach((unlisten) => unlisten());
        if (IS_MAC) {
          await invoke("stop_hotkey_capture").catch(() => {});
        }
        if (this.paused) {
          setHotkeyPaused(false);
          this.paused = false;
        }
        if (restoreSpec) {
          try {
            await applyHotkey(restoreSpec);
          } catch (error) {
            // A failed new binding must not leave the user without the
            // shortcut that was active before capture began.
            if (committedSpec && previousSpec && previousSpec !== restoreSpec) {
              await applyHotkey(previousSpec).catch(() => {});
            }
            restoreError = error;
          }
        }
      }
      // Surface a restore failure OUTSIDE the finally block: throwing from
      // within finally (no-unsafe-finally) would mask other control flow.
      if (restoreError) throw restoreError;
    })();

    this.cleanupInFlight = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.cleanupInFlight === cleanup) this.cleanupInFlight = null;
      this.callbacks.onBusyChange(false);
    }
  }

  private async commit(spec: string): Promise<void> {
    if (this.done) return;
    try {
      await this.cleanup(spec);
      this.callbacks.onCommit(spec);
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    this.callbacks.onError(error instanceof Error ? error.message : String(error));
  }
}

export function HotkeyRecorder({ value, onChange }: HotkeyRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingModifiers, setPendingModifiers] = useState<string[]>([]);
  const [committed, setCommitted] = useState<string | null>(null);
  const [showFnHint, setShowFnHint] = useState(false);
  const [unsupportedKey, setUnsupportedKey] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;

  const sessionRef = useRef<HotkeyCaptureSession | null>(null);
  if (!sessionRef.current) {
    const ifMounted = <T extends unknown[]>(callback: (...args: T) => void) =>
      (...args: T) => {
        if (mountedRef.current) callback(...args);
      };

    sessionRef.current = new HotkeyCaptureSession({
      onRecordingChange: ifMounted(setRecording),
      onBusyChange: ifMounted(setBusy),
      onPendingModifiersChange: ifMounted(setPendingModifiers),
      onReset: ifMounted(() => {
        setPendingModifiers([]);
        setCommitted(null);
        setUnsupportedKey(null);
        setShowFnHint(false);
      }),
      onCommit: (spec) => {
        // Always propagate the committed spec — even if the recorder unmounted
        // mid-commit — so the saved preference can't desync from the hotkey
        // that cleanup() already applied natively.
        if (mountedRef.current) setCommitted(spec);
        onChangeRef.current(spec);
      },
      onFnCaptureUnavailable: ifMounted(() => setShowFnHint(true)),
      onUnsupportedKey: ifMounted((key: string) => setUnsupportedKey(key || null)),
      onError: ifMounted((message) => {
        if (!handleInputMonitoringError(message)) {
          toast.error("Couldn't change the shortcut", { description: message });
        }
      }),
    });
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void sessionRef.current?.cleanup().catch(() => {});
    };
  }, []);

  const dismissFnHint = () => {
    setShowFnHint(false);
  };

  const enableInputMonitoring = async () => {
    try {
      await invoke("request_input_monitoring");
    } catch {
      // System Settings is still useful when the explicit prompt cannot run.
    }
    await invoke("open_input_monitoring_settings").catch(() => {});
    dismissFnHint();
  };

  const displayed = committed ?? value;
  const tokens =
    recording && pendingModifiers.length > 0
      ? pendingModifiers
      : recording
        ? []
        : parts(displayed);

  const helperContent = recording ? (
    <p className="max-w-[320px] text-right text-[11px] leading-snug text-text-muted">
      Press a key or combination… Current shortcut is temporarily cleared.
    </p>
  ) : displayed === "Fn" ? (
    <p className="max-w-[280px] text-right text-[11px] leading-snug text-text-muted">
      Hold <Kbd>fn</Kbd> to talk · If it opens the emoji picker, set System
      Settings → Keyboard → &ldquo;Press 🌐 key to&rdquo; → Do Nothing.
    </p>
  ) : displayed && parts(displayed).length === 1 ? (
    <p className="max-w-[280px] text-right text-[11px] leading-snug text-text-muted">
      Hold to talk.
    </p>
  ) : null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={recording || busy}
          onClick={() => void sessionRef.current?.start(valueRef.current)}
          className={cn(
            "flex h-9 min-w-[160px] items-center justify-center gap-1 rounded-md border px-3 transition-colors disabled:cursor-default",
            recording
              ? "border-accent-solid/60 bg-accent-solid/10 text-accent-start"
              : "border-border-subtle bg-bg-base text-text-primary hover:border-border-strong disabled:opacity-70",
          )}
          aria-label={recording ? "Recording shortcut" : "Record shortcut"}
        >
          {tokens.length === 0 ? (
            recording ? (
              <span className="text-xs text-text-secondary">
                Press a key or combination…
              </span>
            ) : busy ? (
              <span className="text-xs text-text-muted">Updating…</span>
            ) : (
              <span className="text-xs text-text-muted">No shortcut</span>
            )
          ) : (
            <>
              {tokens.map((token, index) => (
                <Kbd key={`${token}-${index}`}>
                  {MODIFIER_LABEL[token] ?? token}
                </Kbd>
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
            disabled={busy}
            onClick={() =>
              void sessionRef.current
                ?.cleanup()
                .catch((error) => {
                  if (!handleInputMonitoringError(error)) {
                    toast.error("Couldn't restore the shortcut", {
                      description:
                        error instanceof Error ? error.message : String(error),
                    });
                  }
                })
            }
          >
            Cancel
          </Button>
        )}
      </div>

      {helperContent}

      {recording && unsupportedKey && (
        <p className="max-w-[320px] text-right text-[11px] leading-snug text-text-muted">
          <Kbd>{unsupportedKey}</Kbd> can&apos;t be a global shortcut on its own —
          add a modifier (⌘/⌃/⌥/⇧) or use a function key (F1–F24)
          {IS_MAC ? " or fn" : ""}.
        </p>
      )}

      {showFnHint && (
        <p className="max-w-[320px] text-right text-[11px] leading-snug text-text-muted">
          Pressing fn needs Input Monitoring (relaunch after enabling) —{" "}
          <button
            type="button"
            className="text-accent-start hover:underline"
            onClick={() => void enableInputMonitoring()}
          >
            Enable
          </button>
          <span aria-hidden="true"> · </span>
          <button
            type="button"
            className="hover:text-text-secondary"
            onClick={dismissFnHint}
          >
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}
