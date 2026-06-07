/**
 * "What's New" launch modal.
 *
 * On launch (and again once a cloud user resolves), compares the persisted
 * `sw.lastSeenVersion` with the running app version. When the user has an
 * existing config and skipped one or more releases, it lists the highlights
 * for those versions and stamps the current version so it only appears once.
 *
 * Fresh / unconfigured installs are silently stamped to the current version
 * so the modal never interrupts first-run onboarding.
 */
import { useEffect, useRef, useState } from "react";
import { Sparkles, ArrowRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/Dialog";
import { Button } from "../ui/Button";
import { useAuth } from "../../lib/store/useAuth";
import { getAppMode } from "../../lib/appMode";
import { isOnboardingComplete } from "../../lib/store/useOnboarding";
import {
  compareVersions,
  getCurrentAppVersion,
  getLastSeenVersion,
  getWhatsNewSince,
  setLastSeenVersion,
  type WhatsNewEntry,
  type WhatsNewLink,
} from "../../lib/whatsNew";

interface Props {
  /** Navigate the app router; used by changelog deep links. */
  navigate: (to: string, state?: Record<string, unknown>) => void;
}

export function WhatsNewModal({ navigate }: Props) {
  const user = useAuth((s) => s.user);
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string>("");
  const [entries, setEntries] = useState<WhatsNewEntry[]>([]);
  const decidedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Decide at most once per app launch; stamping makes it idempotent
      // regardless, but this avoids redundant version lookups.
      if (decidedRef.current) return;

      // In cloud mode the onboarding flag is keyed by user id, so wait
      // until the user resolves before deciding. The effect re-runs when
      // `user` changes.
      if (getAppMode() === "cloud" && !user) return;

      const current = await getCurrentAppVersion();
      if (cancelled || !current) return;

      decidedRef.current = true;

      const lastSeen = getLastSeenVersion();

      // Already on (or ahead of) this version — nothing to show.
      if (lastSeen !== null && compareVersions(lastSeen, current) >= 0) return;

      // No existing config: this is a fresh install or onboarding is still
      // in progress. Stamp silently so we never show "What's New" for the
      // version the user just installed.
      if (!isOnboardingComplete()) {
        setLastSeenVersion(current);
        return;
      }

      const since = getWhatsNewSince(lastSeen, current);

      // Stamp immediately so the modal is shown at most once, even if the
      // effect re-runs.
      setLastSeenVersion(current);

      if (since.length > 0) {
        setVersion(current);
        setEntries(since);
        setOpen(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleLink = (link: WhatsNewLink) => {
    setOpen(false);
    navigate(link.to, link.settingsTab ? { settingsTab: link.settingsTab } : undefined);
  };

  if (!open || entries.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent-start" />
            <DialogTitle>What's New</DialogTitle>
          </div>
          <DialogDescription>
            You're now on Verbatim AI {version}. Here's what changed.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto py-1">
          {entries.map((entry) => (
            <div key={entry.version} className="flex flex-col gap-3">
              {entries.length > 1 && (
                <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Version {entry.version}
                </div>
              )}
              {entry.highlights.map((item, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <div className="text-sm font-medium text-text-primary">
                    {item.title}
                  </div>
                  <div className="text-sm text-text-secondary">
                    {item.description}
                  </div>
                  {item.link && (
                    <div className="pt-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleLink(item.link!)}
                      >
                        {item.link.label}
                        <ArrowRight className="ml-1 h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="primary" size="sm" onClick={() => setOpen(false)}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
