/**
 * "What's New" modal.
 *
 * Rendered inside the main app shell. On mount it compares the running
 * app version against `sw.lastSeenVersion` and, if the user has skipped
 * past one or more changelog entries, presents them once. Dismissing (or
 * following a deep link) writes the current version back so the modal
 * stays suppressed until the next release.
 *
 * Changelog content is data-driven — see `src/lib/whatsNew.ts`.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, ArrowRight } from "lucide-react";
import { Button } from "../ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/Dialog";
import {
  getCurrentVersion,
  getLastSeenVersion,
  getWhatsNewSince,
  setLastSeenVersion,
  type WhatsNewRelease,
} from "../../lib/whatsNew";

export function WhatsNewModal() {
  const navigate = useNavigate();
  const [releases, setReleases] = useState<WhatsNewRelease[] | null>(null);
  const [open, setOpen] = useState(false);
  const versionRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await getCurrentVersion();
      if (cancelled) return;
      versionRef.current = current;
      const pending = getWhatsNewSince(getLastSeenVersion(), current);
      if (pending.length === 0) {
        // Nothing new to show — keep the marker current so the next
        // release compares against the right baseline.
        setLastSeenVersion(current);
        return;
      }
      setReleases(pending);
      setOpen(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const acknowledge = () => {
    if (versionRef.current) setLastSeenVersion(versionRef.current);
    setOpen(false);
  };

  const handleDeepLink = (to: string) => {
    acknowledge();
    navigate(to);
  };

  if (!releases) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) acknowledge();
      }}
    >
      <DialogContent className="max-h-[80vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-accent-start" />
            What's new in Verbatim AI
          </DialogTitle>
          <DialogDescription>
            Here's what changed since you were last here. Your setup carried over untouched.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 max-h-[52vh] space-y-6 overflow-y-auto px-1">
          {releases.map((release) => (
            <section key={release.version} className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="rounded bg-bg-elevated px-2 py-0.5 font-mono text-xs text-text-secondary">
                  v{release.version}
                </span>
                {release.entry.headline ? (
                  <span className="text-sm font-medium text-text-primary">
                    {release.entry.headline}
                  </span>
                ) : null}
              </div>
              <ul className="space-y-3">
                {release.entry.items.map((item, i) => (
                  <li
                    key={i}
                    className="rounded-lg2 border border-border-subtle bg-white/[0.02] p-3"
                  >
                    <div className="text-sm font-medium text-text-primary">{item.title}</div>
                    <p className="mt-1 text-sm text-text-secondary">{item.description}</p>
                    {item.deepLink ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="mt-3"
                        onClick={() => handleDeepLink(item.deepLink as string)}
                      >
                        {item.deepLinkLabel ?? "Take me there"}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <DialogFooter>
          <Button variant="primary" size="sm" onClick={acknowledge}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
