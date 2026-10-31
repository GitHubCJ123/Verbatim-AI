import { useId, useRef, useState } from "react";
import { BookPlus, Check } from "lucide-react";
import { useVocabulary } from "../../lib/store/useModes";
import { MAX_VOCABULARY_TERM_LENGTH } from "../../lib/vocab";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

interface CorrectionVocabularyActionProps {
  selectedText?: string;
  disabled?: boolean;
}

export function CorrectionVocabularyAction({
  selectedText = "",
  disabled = false,
}: CorrectionVocabularyActionProps) {
  const add = useVocabulary((state) => state.add);
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savingRef = useRef(false);
  const id = useId();

  const confirm = async () => {
    if (savingRef.current || disabled) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await add({ term });
      setTerm("");
      setOpen(false);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the term. Try again.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            setTerm(selectedText.trim());
            setError(null);
            setSaved(false);
            setOpen(true);
          }}
        >
          <BookPlus className="h-3.5 w-3.5" />
          Add corrected term
        </Button>
        {saved && (
          <span role="status" className="flex items-center gap-1 text-xs text-text-secondary">
            <Check className="h-3.5 w-3.5" /> Saved to Vocabulary
          </span>
        )}
      </div>
    );
  }

  return (
    <form
      className="rounded-md border border-accent-solid/30 bg-bg-base p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void confirm();
      }}
      onKeyDown={(event) => {
        // Review's global shortcuts must not paste/discard while confirming a term.
        if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
          event.stopPropagation();
          event.preventDefault();
          if (event.key === "Escape" && !saving) {
            setOpen(false);
            setTerm("");
            setError(null);
          }
        }
      }}
    >
      <label htmlFor={id} className="text-xs font-medium text-text-primary">
        Remember this spelling
      </label>
      <p id={`${id}-hint`} className="mb-2 mt-1 text-[11px] leading-snug text-text-muted">
        Save only a term or short phrase. Nothing is learned automatically. Manage saved terms in
        Vocabulary.
      </p>
      <Input
        id={id}
        autoFocus
        value={term}
        placeholder="Corrected term (e.g. Kubernetes)"
        disabled={saving || disabled}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
        aria-invalid={Boolean(error)}
        onChange={(event) => {
          setTerm(event.target.value);
          setError(null);
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-text-muted">
          Term only · up to {MAX_VOCABULARY_TERM_LENGTH} characters
        </span>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setOpen(false);
              setTerm("");
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving || disabled}>
            {saving ? "Saving..." : "Save term"}
          </Button>
        </div>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
