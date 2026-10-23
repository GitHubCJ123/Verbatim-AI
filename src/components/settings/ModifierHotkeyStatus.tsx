/**
 * Live setup status for the macOS fn / right ⌘ hotkeys.
 *
 * These hotkeys need the Input Monitoring permission (and usually a relaunch
 * after granting it), and fn also collides with whatever macOS's own
 * "Press 🌐 key to" setting does. Instead of a one-shot error toast, this
 * panel polls the real state and tells the user exactly which step is left —
 * and activates the hotkey on its own once the permission shows up.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import {
  applyHotkey,
  getModifierHotkeyStatus,
  needsInputMonitoring,
  type ModifierHotkeyStatus as Status,
} from "../../lib/hotkey";
import { Button } from "../ui/Button";
import { Kbd } from "../ui/Kbd";

const POLL_MS = 1500;

const FN_USAGE_LABEL: Record<Status["fnKeyUsage"], string | null> = {
  none: null,
  unknown: null,
  emoji: "opens the emoji picker",
  "input-source": "switches the input source",
  dictation: "starts Apple Dictation",
};

export function ModifierHotkeyStatus({ spec }: { spec: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [activating, setActivating] = useState(false);
  const activateAttempted = useRef(false);
  const relevant = needsInputMonitoring(spec);

  useEffect(() => {
    if (!relevant) return;
    let cancelled = false;
    activateAttempted.current = false;
    const poll = async () => {
      try {
        const next = await getModifierHotkeyStatus();
        if (cancelled) return;
        setStatus(next);
        // Permission just appeared (no relaunch needed on newer macOS):
        // register the hotkey once without making the user click anything.
        if (next.inputMonitoringGranted && !next.listenerActive && !activateAttempted.current) {
          activateAttempted.current = true;
          await applyHotkey(spec).catch(() => {});
          if (!cancelled) setStatus(await getModifierHotkeyStatus());
        }
      } catch {
        /* status is best-effort */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [spec, relevant]);

  if (!relevant || !status?.supported) return null;

  const keyName = spec === "Fn" ? "fn" : "right ⌘";
  const fnConflict = spec === "Fn" ? FN_USAGE_LABEL[status.fnKeyUsage] : null;

  const grant = async () => {
    await invoke("request_input_monitoring").catch(() => {});
    await invoke("open_input_monitoring_settings").catch(() => {});
  };

  const relaunch = async () => {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch {
      /* user can quit and reopen manually */
    }
  };

  const activate = async () => {
    setActivating(true);
    try {
      await applyHotkey(spec);
    } catch {
      /* status poll shows what's still missing */
    } finally {
      setActivating(false);
      setStatus(await getModifierHotkeyStatus().catch(() => status));
    }
  };

  const ready = status.inputMonitoringGranted && status.listenerActive;

  return (
    <div className="flex max-w-[340px] flex-col gap-2 rounded-md border border-border-subtle bg-bg-elevated/60 p-3 text-left text-[11px] leading-snug">
      {ready ? (
        <div className="flex items-start gap-1.5 text-text-secondary">
          <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-success" />
          <span>
            Ready — hold <Kbd>{keyName}</Kbd> anywhere to dictate, release to paste.
          </span>
        </div>
      ) : !status.inputMonitoringGranted ? (
        <>
          <div className="flex items-start gap-1.5 text-text-secondary">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
            <span>
              <Kbd>{keyName}</Kbd> needs <b>Input Monitoring</b>. Turn on Verbatim AI in System
              Settings → Privacy &amp; Security → Input Monitoring. If it still isn&apos;t ready a
              few seconds later, relaunch.
            </span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => void grant()}>
              Grant access
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void relaunch()}>
              Relaunch
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-start gap-1.5 text-text-secondary">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
            <span>Permission granted, but the {keyName} listener isn&apos;t running yet.</span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={activating} onClick={() => void activate()}>
              {activating && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Activate
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void relaunch()}>
              Relaunch
            </Button>
          </div>
        </>
      )}

      {fnConflict && (
        <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-2">
          <div className="flex items-start gap-1.5 text-text-secondary">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
            <span>
              Your fn key also {fnConflict}. Set System Settings → Keyboard → &ldquo;Press 🌐 key
              to&rdquo; → <b>Do Nothing</b>.
            </span>
          </div>
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void invoke("open_keyboard_settings").catch(() => {})}
            >
              Open Keyboard settings
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
