import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isMac } from "../../lib/os";
import { PASTE_PERMISSION_SETTINGS_PATH } from "../../lib/permissions";
import { openPastePermissionSettings } from "../settings/accessibility";
import { Button } from "../ui/Button";

export function PastePermissionBanner() {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!isMac()) return;
    let active = true;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const trusted = await invoke<boolean>("check_accessibility_permission");
        if (active) {
          setGranted(trusted);
          setError(null);
          if (trusted) setOpenError(null);
        }
      } catch {
        if (active)
          setError(
            "Typing permission couldn't be checked. Check the setting below before dictating.",
          );
      } finally {
        checking = false;
      }
    };
    void check();
    window.addEventListener("focus", check);
    const timer = window.setInterval(check, 5000);
    return () => {
      active = false;
      window.removeEventListener("focus", check);
      window.clearInterval(timer);
    };
  }, []);

  const openSettings = async () => {
    setOpening(true);
    try {
      await openPastePermissionSettings();
      setOpenError(null);
    } catch {
      setOpenError("Couldn't open System Settings. Open the setting below manually.");
    } finally {
      setOpening(false);
    }
  };

  if (!isMac() || (granted !== false && !error)) return null;

  return (
    <section
      role="status"
      aria-label="Typing permission setup"
      className="mx-5 my-3 shrink-0 rounded-md border border-warning/30 bg-warning/10 p-4 text-sm text-text-primary"
    >
      <h2 className="font-semibold">Allow Verbatim AI to type into other apps</h2>
      <p className="mt-1 text-text-secondary">
        {openError ??
          error ??
          "macOS is blocking automatic paste. You can still record and Copy your text."}
      </p>
      <ol className="mt-2 list-inside list-decimal space-y-1 text-text-secondary">
        <li>Open {PASTE_PERMISSION_SETTINGS_PATH}.</li>
        <li>Turn on Verbatim AI. If missing, click + and add Verbatim AI.app from Applications.</li>
        <li>
          If already enabled after an update, Copy unsaved text, then fully quit and reopen Verbatim
          AI.
        </li>
      </ol>
      <Button
        variant="secondary"
        size="sm"
        className="mt-3"
        disabled={opening}
        onClick={openSettings}
      >
        {opening ? "Opening Settings…" : "Open System Settings"}
      </Button>
    </section>
  );
}
