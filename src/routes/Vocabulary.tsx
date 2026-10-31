import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, Upload, Download, BookText } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { IconButton } from "../components/ui/IconButton";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { useVocabulary } from "../lib/store/useModes";
import { toast } from "../components/ui/Toast";

export default function Vocabulary() {
  const terms = useVocabulary((s) => s.terms);
  const add = useVocabulary((s) => s.add);
  const update = useVocabulary((s) => s.update);
  const remove = useVocabulary((s) => s.remove);
  const importMany = useVocabulary((s) => s.importMany);
  const hydrate = useVocabulary((s) => s.hydrate);

  const [draft, setDraft] = useState({ term: "", replacement: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reportError = (cause: unknown) => {
    const message =
      cause instanceof Error ? cause.message : "Could not save Vocabulary. Try again.";
    setError(message);
  };

  useEffect(() => {
    // Refresh terms explicitly added from the Review WebView.
    void hydrate().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not load Vocabulary.");
    });
  }, [hydrate]);

  const handleAdd = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await add({
        term: draft.term,
        replacement: draft.replacement.trim() || null,
        notes: draft.notes.trim() || null,
      });
      setDraft({ term: "", replacement: "", notes: "" });
    } catch (cause) {
      reportError(cause);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleImport = async (file: File) => {
    try {
      const text = await file.text();
      const rows = text
        .split(/\r?\n/)
        .map((line) => line.split(",").map((cell) => cell.trim()))
        .filter((cells) => cells[0]);

      // Skip header row if it looks like one
      const start = rows[0]?.[0]?.toLowerCase() === "term" ? 1 : 0;
      const items = rows.slice(start).map((cells) => ({
        term: cells[0] ?? "",
        replacement: cells[1] || null,
        pronunciation: cells[2] || null,
        notes: cells[3] || null,
      }));
      const n = await importMany(items);
      toast.success(`Imported ${n} term${n === 1 ? "" : "s"}`);
      setError(null);
    } catch (cause) {
      reportError(cause);
    }
  };

  const handleExport = () => {
    const lines = [
      "term,replacement,pronunciation,notes",
      ...terms.map((t) =>
        [t.term, t.replacement ?? "", t.pronunciation ?? "", t.notes ?? ""]
          .map((c) => (c.includes(",") ? `"${c.replace(/"/g, '""')}"` : c))
          .join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "verbatim-ai-vocabulary.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <PageContainer>
      <PageHeader
        title="Vocabulary"
        description={`Keep proper nouns spelled correctly, and define replacements (e.g. "gonna" → "going to") that run after cleanup.`}
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImport(f);
                e.target.value = "";
              }}
            />
            <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" />
              Import CSV
            </Button>
            <Button variant="ghost" size="sm" onClick={handleExport} disabled={terms.length === 0}>
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
          </>
        }
      />

      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}

      <Card className="mb-4">
        <CardContent className="flex items-center gap-2 p-3">
          <Input
            placeholder="Term (e.g. Kubernetes)"
            className="flex-1"
            value={draft.term}
            disabled={saving}
            onChange={(e) => setDraft((d) => ({ ...d, term: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAdd();
            }}
          />
          <Input
            placeholder="Replace with (optional)"
            className="flex-1"
            value={draft.replacement}
            disabled={saving}
            onChange={(e) => setDraft((d) => ({ ...d, replacement: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAdd();
            }}
          />
          <Input
            placeholder="Notes (optional)"
            className="flex-1"
            value={draft.notes}
            disabled={saving}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAdd();
            }}
          />
          <Button variant="primary" size="sm" onClick={() => void handleAdd()} disabled={saving}>
            <Plus className="h-3.5 w-3.5" />
            {saving ? "Saving..." : "Add"}
          </Button>
        </CardContent>
      </Card>

      {terms.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 p-16 pt-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-pill bg-bg-elevated">
              <BookText className="h-5 w-5 text-text-muted" strokeWidth={1.5} />
            </div>
            <div className="text-sm font-medium">No custom terms</div>
            <div className="max-w-sm text-xs text-text-muted">
              Add product names, people, or jargon you use often.
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-xs text-text-muted">
                  <th className="px-5 py-3 text-left font-medium">Term</th>
                  <th className="px-5 py-3 text-left font-medium">Replace with</th>
                  <th className="px-5 py-3 text-left font-medium">Notes</th>
                  <th className="w-12" />
                </tr>
              </thead>
              <tbody>
                {terms.map((t) => (
                  <tr key={t.id} className="border-b border-border-subtle last:border-b-0">
                    <td className="px-5 py-2">
                      <Input
                        value={t.term}
                        onChange={(e) =>
                          void update(t.id, { term: e.target.value }).catch(reportError)
                        }
                        className="h-8 border-transparent bg-transparent px-2"
                      />
                    </td>
                    <td className="px-5 py-2">
                      <Input
                        value={t.replacement ?? ""}
                        onChange={(e) =>
                          void update(t.id, { replacement: e.target.value || null }).catch(
                            reportError,
                          )
                        }
                        className="h-8 border-transparent bg-transparent px-2 text-text-secondary"
                        placeholder="—"
                      />
                    </td>
                    <td className="px-5 py-2">
                      <Input
                        value={t.notes ?? ""}
                        onChange={(e) =>
                          void update(t.id, { notes: e.target.value || null }).catch(reportError)
                        }
                        className="h-8 border-transparent bg-transparent px-2 text-text-secondary"
                        placeholder="—"
                      />
                    </td>
                    <td className="px-5 py-2 text-right">
                      <IconButton
                        size="sm"
                        onClick={() => void remove(t.id).catch(reportError)}
                        className="hover:text-danger"
                        aria-label="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}
