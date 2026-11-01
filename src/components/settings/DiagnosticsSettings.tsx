import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "../ui/Button";
import { Switch } from "../ui/Switch";
import { toast } from "../ui/Toast";
import {
  deleteDiagnostics,
  formatDiagnostics,
  getDiagnostics,
  setDiagnosticsEnabled,
  type DiagnosticReport,
} from "../../lib/diagnostics";

const READ_ERROR =
  "Diagnostics couldn't be read or updated. Delete and turn them off to reset the journal. If deletion fails, they may resume after a restart.";
const DELETE_ERROR =
  "Diagnostics couldn't be deleted. They may still exist and resume after a restart; check storage access and try again.";

export function DiagnosticsSettings() {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let active = true;
    void getDiagnostics()
      .then((next) => {
        if (active) setReport(next);
      })
      .catch(() => {
        if (active) setError(READ_ERROR);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const changeEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      setReport(await setDiagnosticsEnabled(enabled));
      setError(null);
    } catch {
      setReport(null);
      setError(enabled ? READ_ERROR : DELETE_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      setReport(await deleteDiagnostics());
      setError(null);
      toast.success("Diagnostics deleted and turned off");
    } catch {
      setReport(null);
      setError(DELETE_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      setReport(await getDiagnostics());
      setError(null);
    } catch {
      setReport(null);
      setError(READ_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!report) return;
    setBusy(true);
    try {
      const current = await getDiagnostics();
      setReport(current);
      setError(null);
      try {
        await writeText(formatDiagnostics(current));
        toast.success("Diagnostics copied");
      } catch {
        toast.error("Couldn't copy diagnostics");
      }
    } catch {
      setReport(null);
      setError(READ_ERROR);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="setting-diagnostics"
      className="scroll-mt-24 rounded-md border-b border-border-subtle py-4 last:border-b-0"
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-0.5">
          <div className="text-sm font-medium">Local diagnostics</div>
          <div className="max-w-2xl text-xs text-text-muted">
            Off by default. When enabled, stores error categories, times, app version and the
            current processing stage, even when transcript history is off. After an unclean exit,
            the last stage may appear in the report. The report also shows OS and architecture. The
            journal contains no transcripts, audio, prompts, clipboard contents, app/window names
            or error messages. It is stored unencrypted on this device; nothing is uploaded.
          </div>
          <div className="mt-1 max-w-2xl text-xs text-text-muted">
            Keeps up to 100 events. Events expire after seven days and are removed on access,
            hourly while running or on the next launch if the app was closed. Diagnostics do not
            recover dictation.
          </div>
        </div>
        <Switch
          aria-label="Store local diagnostics"
          checked={report?.enabled ?? false}
          disabled={busy || !report}
          onCheckedChange={(enabled) => void changeEnabled(enabled)}
        />
      </div>
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || !report || report.events.length === 0}
          onClick={() => void copy()}
        >
          Copy diagnostics
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void clear()}>
          Delete and turn off
        </Button>
        {report && (
          <span className="text-xs text-text-muted">
            {report.events.length} event{report.events.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {report && report.events.length > 0 && (
        <details className="mt-3 text-xs text-text-secondary">
          <summary className="cursor-pointer">Review diagnostics before copying</summary>
          <p className="mt-2 text-text-muted">
            An unclean exit can also mean a forced quit or interrupted shutdown. The last stage is
            best-effort, and the event time is when the next launch detected it.
          </p>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-bg-base/40 p-3">
            {formatDiagnostics(report)}
          </pre>
        </details>
      )}
    </div>
  );
}
