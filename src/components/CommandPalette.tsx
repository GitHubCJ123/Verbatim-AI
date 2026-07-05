/**
 * Cmd+K command palette (docs/improvement-plan/02-settings-ux.md, step 3).
 *
 * Searches the settings registry + pages and deep-links into the
 * Settings tabs with a row highlight. Opens via ⌘K / Ctrl+K or the
 * `open-command-palette` window event (used by the Sidebar button).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, CornerDownLeft } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./ui/Dialog";
import { cn } from "../lib/utils";
import {
  entryHref,
  searchSettings,
  type SettingsSearchEntry,
} from "../lib/settingsRegistry";

const TAB_LABEL: Record<string, string> = {
  general: "General",
  model: "AI model",
  recording: "Recording",
  privacy: "Privacy",
  advanced: "Advanced",
};

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const results = useMemo(() => searchSettings(query), [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpenEvent = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpenEvent);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const pick = (entry: SettingsSearchEntry) => {
    setOpen(false);
    navigate(entryHref(entry));
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      pick(results[active]);
    }
  };

  // Keep the active row visible while arrowing.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-24 max-w-xl translate-y-0 p-0">
        <DialogTitle className="sr-only">Search settings</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search settings… (hotkey, microphone, privacy…)"
            className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-text-muted">
              Nothing matches "{query}".
            </div>
          ) : (
            results.map((entry, i) => (
              <button
                key={entry.id}
                type="button"
                data-index={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(entry)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left",
                  i === active ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
                )}
              >
                <div className="min-w-0">
                  <div className="text-sm text-text-primary">{entry.title}</div>
                  <div className="truncate text-xs text-text-muted">{entry.description}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="rounded-sm border border-border-subtle bg-bg-elevated px-1.5 py-0.5 text-[10px] text-text-muted">
                    {entry.tab ? `Settings · ${TAB_LABEL[entry.tab]}` : "Page"}
                  </span>
                  {i === active && (
                    <CornerDownLeft className="h-3 w-3 text-text-muted" />
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent("open-command-palette"));
}
