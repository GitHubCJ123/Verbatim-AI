/**
 * Top-of-app banner that announces a downloaded update.
 *
 * Shown only when `getUpdateStatus().kind === "ready"`. User picks
 * "Install now" (relaunches into the new version) or "Later" (banner
 * hides; user can still install from Settings → General).
 */
import { useEffect, useState } from "react";
import { Download, X, Loader2 } from "lucide-react";
import { Button } from "../ui/Button";
import { toast } from "../ui/Toast";
import {
  getUpdateStatus,
  subscribeUpdateStatus,
  installAndRelaunch,
  type UpdateStatus,
} from "../../lib/updater";

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>(getUpdateStatus());
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => subscribeUpdateStatus(setStatus), []);

  if (dismissed) return null;
  if (status.kind !== "ready") return null;

  const handleInstall = async () => {
    setInstalling(true);
    try {
      await installAndRelaunch();
    } catch (e) {
      setInstalling(false);
      toast.error("Couldn't install update", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="border-b border-border-subtle bg-accent/10 px-6 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Download className="h-4 w-4 shrink-0 text-accent-start" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              Verbatim AI {status.version} is ready to install
            </div>
            <div className="truncate text-xs text-text-muted">
              You're on {status.currentVersion}. Restart to apply, or install later from Settings.
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="primary" size="sm" onClick={handleInstall} disabled={installing}>
            {installing ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Install now
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setDismissed(true)}
            title="Later"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
