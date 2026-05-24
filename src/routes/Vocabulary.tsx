import { useRef, useState } from "react";
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

  const [draft, setDraft] = useState({ term: "", notes: "" });
  const fileRef = useRef<HTMLInputElement>(null);

  const handleAdd = () => {
    if (!draft.term.trim()) return;
    add({ term: draft.term.trim(), notes: draft.notes.trim() || null });
    setDraft({ term: "", notes: "" });
  };

  const handleImport = async (file: File) => {
    const text = await file.text();
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.split(",").map((cell) => cell.trim()))
      .filter((cells) => cells[0]);

    // Skip header row if it looks like one
    const start = rows[0]?.[0]?.toLowerCase() === "term" ? 1 : 0;
    const items = rows.slice(start).map((cells) => ({
      term: cells[0] ?? "",
      pronunciation: cells[1] || null,
      notes: cells[2] || null,
    }));
    const n = importMany(items);
    toast.success(`Imported ${n} term${n === 1 ? "" : "s"}`);
  };

  const handleExport = () => {
    const lines = [
      "term,pronunciation,notes",
      ...terms.map((t) =>
        [t.term, t.pronunciation ?? "", t.notes ?? ""]
          .map((c) => (c.includes(",") ? `"${c.replace(/"/g, '""')}"` : c))
          .join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "superwisper-vocabulary.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <PageContainer>
      <PageHeader
        title="Vocabulary"
        description="Specialized terms so proper nouns stay spelled correctly. Injected into every cleanup prompt."
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
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExport}
              disabled={terms.length === 0}
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
          </>
        }
      />

      <Card className="mb-4">
        <CardContent className="flex items-center gap-2 p-3">
          <Input
            placeholder="Term (e.g. Kubernetes)"
            className="flex-1"
            value={draft.term}
            onChange={(e) => setDraft((d) => ({ ...d, term: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
          />
          <Input
            placeholder="Notes (optional)"
            className="flex-1"
            value={draft.notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
          />
          <Button variant="primary" size="sm" onClick={handleAdd} disabled={!draft.term.trim()}>
            <Plus className="h-3.5 w-3.5" />
            Add
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
                        onChange={(e) => update(t.id, { term: e.target.value })}
                        className="h-8 border-transparent bg-transparent px-2"
                      />
                    </td>
                    <td className="px-5 py-2">
                      <Input
                        value={t.notes ?? ""}
                        onChange={(e) => update(t.id, { notes: e.target.value || null })}
                        className="h-8 border-transparent bg-transparent px-2 text-text-secondary"
                        placeholder="—"
                      />
                    </td>
                    <td className="px-5 py-2 text-right">
                      <IconButton
                        size="sm"
                        onClick={() => remove(t.id)}
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
