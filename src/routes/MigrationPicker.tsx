/**
 * Shown after a local→cloud sign-in when `sw.migration.pending` is set.
 * Lets the user pick which categories of local data to upload to the
 * new account. They can also skip everything and start fresh.
 */
import { useEffect, useState } from "react";
import { Cloud, Loader2, ListChecks } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Switch } from "../components/ui/Switch";
import { Badge } from "../components/ui/Badge";
import {
  clearMigrationPending,
  loadLocalSnapshot,
  migrateLocalToCloud,
  type MigrationSelection,
} from "../lib/migration";
import { hydrateAll } from "../lib/store/useModes";
import { useAppMappings } from "../lib/store/useAppMappings";
import { useProfile } from "../lib/store/useProfile";
import { toast } from "../components/ui/Toast";

interface MigrationPickerProps {
  onDone: () => void;
}

export default function MigrationPicker({ onDone }: MigrationPickerProps) {
  const [snap, setSnap] = useState(() => loadLocalSnapshot());
  const userModes = snap.modes.filter((m) => !m.isBuiltin);

  const [selection, setSelection] = useState<MigrationSelection>({
    modes: userModes.length > 0,
    vocabulary: snap.vocabulary.length > 0,
    appMappings: snap.appMappings.length > 0,
    transcriptions: snap.transcriptions.length > 0,
  });
  const [submitting, setSubmitting] = useState(false);

  // Re-read in case anything changed under us.
  useEffect(() => {
    setSnap(loadLocalSnapshot());
  }, []);

  const totalSelected =
    (selection.modes ? userModes.length : 0) +
    (selection.vocabulary ? snap.vocabulary.length : 0) +
    (selection.appMappings ? snap.appMappings.length : 0) +
    (selection.transcriptions ? snap.transcriptions.length : 0);

  const handleMigrate = async () => {
    setSubmitting(true);
    try {
      const result = await migrateLocalToCloud(selection);
      const total = result.modes + result.vocabulary + result.appMappings + result.transcriptions;
      if (total > 0) {
        toast.success(
          `Migrated ${result.modes} modes, ${result.vocabulary} terms, ${result.appMappings} app rules, ${result.transcriptions} transcripts`,
        );
      } else {
        toast.info("Skipped local data — starting fresh in the cloud.");
      }
    } catch (e) {
      toast.error("Migration failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      await hydrateAll();
      await useAppMappings.getState().hydrate();
      await useProfile.getState().hydrate();
    } catch (e) {
      console.warn("[Verbatim AI] post-migration hydrate failed:", e);
    }
    clearMigrationPending();
    setSubmitting(false);
    onDone();
  };

  const handleSkipAll = async () => {
    setSubmitting(true);
    try {
      await hydrateAll();
      await useAppMappings.getState().hydrate();
      await useProfile.getState().hydrate();
    } catch {
      /* ignore */
    }
    clearMigrationPending();
    setSubmitting(false);
    toast.info("Local data kept on this device — not uploaded.");
    onDone();
  };

  return (
    <div
      className="relative flex h-screen w-screen items-start justify-center overflow-auto bg-bg-base px-6 py-10 text-text-primary"
      style={{
        backgroundImage:
          "radial-gradient(80% 60% at 50% 0%, rgba(168, 85, 247, 0.18), transparent 70%)",
      }}
    >
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-lg2 bg-gradient-to-br from-accent-start to-accent-end shadow-glow">
            <Cloud className="h-6 w-6 text-white" strokeWidth={2} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Migrate your local data?</h1>
          <p className="mt-2 text-sm text-text-secondary">
            You signed in. Pick which categories to upload to your account, or skip
            everything to start fresh.
          </p>
        </div>

        <Card>
          <CardContent className="flex flex-col gap-1 p-2">
            <Row
              title="Modes"
              count={userModes.length}
              preview={userModes.slice(0, 3).map((m) => m.name).join(" · ")}
              checked={selection.modes}
              onChange={(v) => setSelection((s) => ({ ...s, modes: v }))}
              disabled={userModes.length === 0}
              note={
                snap.modes.length > userModes.length
                  ? "Built-in modes won't be migrated — your account gets fresh ones automatically."
                  : undefined
              }
            />
            <Row
              title="Vocabulary"
              count={snap.vocabulary.length}
              preview={snap.vocabulary.slice(0, 3).map((v) => v.term).join(" · ")}
              checked={selection.vocabulary}
              onChange={(v) => setSelection((s) => ({ ...s, vocabulary: v }))}
              disabled={snap.vocabulary.length === 0}
            />
            <Row
              title="App rules"
              count={snap.appMappings.length}
              preview={snap.appMappings.slice(0, 3).map((a) => a.appDisplayName).join(" · ")}
              checked={selection.appMappings}
              onChange={(v) => setSelection((s) => ({ ...s, appMappings: v }))}
              disabled={snap.appMappings.length === 0}
            />
            <Row
              title="Transcripts"
              count={snap.transcriptions.length}
              preview={
                snap.transcriptions[0]?.cleaned_text?.slice(0, 60) ?? ""
              }
              checked={selection.transcriptions}
              onChange={(v) => setSelection((s) => ({ ...s, transcriptions: v }))}
              disabled={snap.transcriptions.length === 0}
            />
          </CardContent>
        </Card>

        <div className="mt-6 flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={handleSkipAll} disabled={submitting}>
            Skip — keep local data on this device only
          </Button>
          <Button variant="primary" size="sm" onClick={handleMigrate} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Migrating…
              </>
            ) : (
              <>
                <ListChecks className="h-3.5 w-3.5" />
                {totalSelected > 0
                  ? `Upload ${totalSelected} item${totalSelected === 1 ? "" : "s"}`
                  : "Upload nothing"}
              </>
            )}
          </Button>
        </div>

        <p className="mt-6 text-center text-xs text-text-muted">
          Heads up: if your account already has cloud data, this will <em>add</em> on top —
          duplicates aren't merged.
        </p>
      </div>
    </div>
  );
}

function Row({
  title,
  count,
  preview,
  checked,
  onChange,
  disabled,
  note,
}: {
  title: string;
  count: number;
  preview: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md px-4 py-3 hover:bg-bg-elevated/60">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          <Badge variant={count === 0 ? "default" : "accent"}>
            {count}
          </Badge>
        </div>
        {preview && (
          <div className="truncate text-xs text-text-muted">{preview}</div>
        )}
        {note && <div className="text-[11px] text-text-secondary">{note}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
