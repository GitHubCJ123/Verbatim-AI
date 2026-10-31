import { useId } from "react";
import { Pencil, Sparkles } from "lucide-react";
import { Button } from "../ui/Button";
import type { Mode } from "../../types/mode";

/** Presentation only: writing styles are the existing Modes, not a separate preference. */
export function WritingStyle({
  modes,
  defaultModeId,
  onSelect,
  onEdit,
}: {
  modes: Mode[];
  defaultModeId: string | null;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const id = useId();
  const active = modes.find((mode) => mode.id === defaultModeId) ?? modes[0];

  return (
    <section className="mb-5 rounded-lg border border-accent-solid/30 bg-bg-elevated/40 p-5">
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent-start" aria-hidden="true" />
        <label htmlFor={id} className="text-sm font-semibold">
          Writing Style
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <select
          id={id}
          value={active?.id ?? ""}
          disabled={!active}
          aria-describedby={`${id}-description`}
          onChange={(event) => onSelect(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border-strong bg-bg-base px-3 py-2.5 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-solid"
        >
          {!active && <option value="">No styles yet</option>}
          {modes.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.name}
            </option>
          ))}
        </select>
        {active && (
          <Button variant="secondary" size="sm" onClick={() => onEdit(active.id)}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Customize
          </Button>
        )}
      </div>
      <p id={`${id}-description`} className="mt-3 text-sm text-text-secondary">
        {active?.description || "Choose how your speech reads after cleanup."}
      </p>
      <p className="mt-2 text-xs text-text-muted">
        Your default for dictation. App-specific modes still take priority.
        {active?.skipCleanup && " This mode skips AI cleanup."}
        {active?.outputStyle === "review" && " This mode opens Review before pasting."}
      </p>
    </section>
  );
}
