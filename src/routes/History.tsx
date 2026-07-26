import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  History as HistoryIcon,
  Trash2,
  ClipboardCopy,
  Send,
  Wand2,
  Cloud,
  HardDrive,
  Loader2,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { IconButton } from "../components/ui/IconButton";
import { Badge } from "../components/ui/Badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/Select";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import {
  listTranscriptions,
  deleteTranscription,
  clearAllTranscriptions,
  type Transcription,
} from "../lib/history";
import { useAuth } from "../lib/store/useAuth";
import { isSupabaseConfigured } from "../lib/supabase";
import { toast } from "../components/ui/Toast";
import { confirmDialog } from "../components/ui/confirmDialog";
import { copyCleanedText, pasteCleanedText } from "../lib/output";
import { notifyAccessibilityRequired } from "../components/settings/accessibility";
import { osKind } from "../lib/os";
import { pasteMethodUsesClipboard } from "../lib/pasteMethod";
import { getOutputBehavior, getPasteMethod, isAiImproveDisabled } from "../lib/preferences";
import { useModes } from "../lib/store/useModes";
import { getActiveProvider } from "../lib/ai";
import { loadVocabulary } from "../lib/store/useModes";

type ModeFilter = "all" | string;

export default function History() {
  const [items, setItems] = useState<Transcription[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const user = useAuth((s) => s.user);
  const supabaseReady = isSupabaseConfigured;
  const modes = useModes((s) => s.modes);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listTranscriptions({ query, limit: 200 });
      setItems(rows);
    } catch (e) {
      toast.error("Couldn't load history", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
    // also refresh when sign-in state flips
  }, [refresh, user]);

  const filtered = useMemo(() => {
    if (modeFilter === "all") return items;
    return items.filter((t) => t.mode_name_snap === modeFilter);
  }, [items, modeFilter]);

  const handleDelete = async (id: string) => {
    try {
      await deleteTranscription(id);
      setItems((rows) => rows.filter((r) => r.id !== id));
    } catch (e) {
      toast.error("Couldn't delete", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleClearAll = async () => {
    if (
      !(await confirmDialog({
        title: "Delete every transcript?",
        message: "This can't be undone.",
        confirmLabel: "Delete all",
        destructive: true,
      }))
    ) {
      return;
    }
    try {
      await clearAllTranscriptions();
      setItems([]);
      toast.success("History cleared");
    } catch (e) {
      toast.error("Couldn't clear history", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const remoteMode = supabaseReady && Boolean(user);

  return (
    <PageContainer>
      <PageHeader
        title="History"
        description="Every transcription you've made, searchable."
        actions={
          <>
            <Badge variant={remoteMode ? "accent" : "default"}>
              {remoteMode ? (
                <>
                  <Cloud className="h-3 w-3" />
                  Cloud
                </>
              ) : (
                <>
                  <HardDrive className="h-3 w-3" />
                  Local
                </>
              )}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearAll}
              disabled={items.length === 0}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear all
            </Button>
          </>
        }
      />

      <div className="mb-4 flex items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
          <Input
            placeholder="Search transcriptions…"
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select value={modeFilter} onValueChange={(v) => setModeFilter(v as ModeFilter)}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All modes</SelectItem>
            {modes.map((m) => (
              <SelectItem key={m.id} value={m.name}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 p-16 text-xs text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState query={query} />
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((t) => (
            <HistoryRow key={t.id} item={t} onDelete={() => handleDelete(t.id)} onReload={refresh} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 p-16 pt-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-pill bg-bg-elevated">
          <HistoryIcon className="h-5 w-5 text-text-muted" strokeWidth={1.5} />
        </div>
        <div className="text-sm font-medium">
          {query ? "No matches" : "No history yet"}
        </div>
        <div className="max-w-sm text-xs text-text-muted">
          {query
            ? "Try a different search term."
            : "Once you start dictating, your transcriptions will appear here."}
        </div>
      </CardContent>
    </Card>
  );
}

function HistoryRow({
  item,
  onDelete,
  onReload,
}: {
  item: Transcription;
  onDelete: () => void;
  onReload: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [recleaning, setRecleaning] = useState(false);

  const cleaned = item.cleaned_text ?? "";
  const preview = cleaned.length > 140 ? cleaned.slice(0, 140) + "…" : cleaned;
  const when = useMemo(() => formatDate(item.created_at), [item.created_at]);

  const handleCopy = async () => {
    await copyCleanedText(cleaned);
    toast.success("Copied to clipboard");
  };

  const handlePaste = async () => {
    const outcome = await pasteCleanedText(cleaned);
    if (outcome === "permission-required") {
      notifyAccessibilityRequired();
      return;
    }
    const behavior = getOutputBehavior();
    const method = behavior === "insert-only" ? "direct" : getPasteMethod();
    const usedClipboard = pasteMethodUsesClipboard(method, osKind());
    if (outcome === "pasted") {
      toast.success("Pasted");
      return;
    }
    if (outcome === "activation-failed") {
      toast.success(
        !usedClipboard
          ? "Couldn't switch to the target app"
          : behavior === "restore"
            ? "Couldn't switch to the target app; clipboard restored"
            : "Couldn't switch to the target app; text copied",
      );
      return;
    }
    toast.success(
      !usedClipboard
        ? "No target window; clipboard unchanged"
        : behavior === "restore"
          ? "No target window; clipboard restored"
          : "Copied (no target window)",
    );
  };

  const handleReclean = async () => {
    if (isAiImproveDisabled()) {
      toast.error("AI cleanup is off", {
        description: "Turn on cleanup in Settings → AI model before re-cleaning transcripts.",
      });
      return;
    }
    const provider = getActiveProvider();
    if (!provider) {
      toast.error("Configure Azure in Settings → AI first");
      return;
    }
    const raw = item.raw_text;
    if (!raw) {
      toast.error("No raw transcript to re-clean");
      return;
    }
    setRecleaning(true);
    try {
      let acc = "";
      for await (const chunk of provider.cleanup({
        rawText: raw,
        systemPrompt: "Polish naturally; preserve the speaker's tone.",
        modeName: item.mode_name_snap ?? "Default",
        vocabulary: loadVocabulary().map((t) => t.term),
      })) {
        acc += chunk;
      }
      await copyCleanedText(acc);
      toast.success("Re-cleaned + copied", { description: acc.slice(0, 120) });
      onReload();
    } catch (e) {
      toast.error("Re-clean failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRecleaning(false);
    }
  };

  return (
    <Card className="group transition-colors hover:bg-bg-elevated/80">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="flex w-32 shrink-0 flex-col gap-1 pt-0.5">
            <div className="text-xs font-medium text-text-secondary">{when}</div>
            {item.mode_name_snap && (
              <Badge variant="accent" className="w-fit">
                {item.mode_name_snap}
              </Badge>
            )}
            {item.output_action && (
              <Badge variant="default" className="w-fit">
                {item.output_action}
              </Badge>
            )}
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex-1 cursor-pointer text-left"
          >
            <div className="whitespace-pre-wrap text-sm text-text-primary">
              {expanded ? cleaned : preview}
            </div>
            {expanded && item.raw_text && item.raw_text !== cleaned && (
              <div className="mt-3 border-l-2 border-border-subtle pl-3 text-xs text-text-muted">
                <div className="mb-1 uppercase tracking-wide">Raw</div>
                <div className="whitespace-pre-wrap">{item.raw_text}</div>
              </div>
            )}
          </button>
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <IconButton size="sm" onClick={handleCopy} aria-label="Copy">
              <ClipboardCopy className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton size="sm" onClick={handlePaste} aria-label="Paste">
              <Send className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton
              size="sm"
              onClick={handleReclean}
              disabled={recleaning}
              aria-label="Re-clean"
            >
              {recleaning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wand2 className="h-3.5 w-3.5" />
              )}
            </IconButton>
            <IconButton
              size="sm"
              onClick={onDelete}
              className="hover:text-danger"
              aria-label="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: sameYear ? undefined : "numeric",
    });
  } catch {
    return iso;
  }
}
