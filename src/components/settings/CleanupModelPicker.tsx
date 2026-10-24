/**
 * The cleanup ("AI polish") model list. Each card downloads the engine and
 * model on first use, verifies it, then becomes selectable.
 */
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Globe } from "lucide-react";
import { toast } from "../ui/Toast";
import { TooltipProvider } from "../ui/Tooltip";
import { ModelCard, type ModelCardState } from "./ModelCard";
import {
  CLEANUP_MODELS,
  deleteCleanupModel,
  downloadCleanupModel,
  ensureCleanupReady,
  getCleanupEngineStatus,
  getCleanupModel,
  setCleanupModel,
  type CleanupDownloadProgress,
  type CleanupModelId,
  type CleanupModelInfo,
} from "../../lib/ai/localCleanup";

function qualityDetail(m: CleanupModelInfo) {
  return (
    <>
      Passed {m.checksPassed} of {m.checksTotal} cleanup checks: fillers, self-corrections, numbers,
      not answering dictated questions, keeping French and Spanish, bullet lists and emails.
    </>
  );
}

function speedDetail(m: CleanupModelInfo) {
  return (
    <>
      ~{m.tokensPerSecond} tokens/s · ~{(m.shortSentenceMs / 1000).toFixed(2)} s for a short
      sentence · ~{m.paragraphSeconds.toFixed(1)} s for a 75-word paragraph. Measured on an Apple M1
      Pro; older or CPU-only machines are slower, in the same order.
    </>
  );
}

export function CleanupModelPicker({ disabled }: { disabled?: boolean }) {
  const [installed, setInstalled] = useState<Partial<Record<CleanupModelId, boolean>>>({});
  const [current, setCurrent] = useState<CleanupModelId>(getCleanupModel);
  const [busy, setBusy] = useState<{
    id: CleanupModelId;
    label: string;
    percent: number | null;
  } | null>(null);

  const refresh = async () => {
    try {
      const status = await getCleanupEngineStatus();
      setInstalled(
        Object.fromEntries(
          status.models.map((m) => [m.id, status.runtimeInstalled && m.installed]),
        ),
      );
    } catch (e) {
      toast.error("Couldn't read downloaded models", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  useEffect(() => {
    void refresh();
    const off = listen<CleanupDownloadProgress>("cleanup:download:progress", (e) =>
      setBusy((b) =>
        b && b.id === e.payload.id
          ? {
              id: b.id,
              label: e.payload.stage === "runtime" ? "Setting up the engine" : "Downloading",
              percent:
                e.payload.total > 0
                  ? Math.round((e.payload.downloaded / e.payload.total) * 100)
                  : null,
            }
          : b,
      ),
    );
    return () => void off.then((fn) => fn());
  }, []);

  const activate = (m: CleanupModelInfo) => {
    setCleanupModel(m.id);
    setCurrent(m.id);
    void ensureCleanupReady(m.id).catch(() => {});
  };

  const download = async (m: CleanupModelInfo) => {
    if (busy) return;
    setBusy({ id: m.id, label: "Starting", percent: null });
    try {
      await downloadCleanupModel(m.id);
      activate(m);
      toast.success(`${m.name} is ready`, {
        description: "It's now used to polish your dictation.",
      });
    } catch (e) {
      toast.error(`Couldn't download ${m.name}`, {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const remove = async (m: CleanupModelInfo) => {
    try {
      await deleteCleanupModel(m.id);
      toast.success(`Deleted ${m.name}`);
    } catch (e) {
      toast.error(`Couldn't delete ${m.name}`, {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      void refresh();
    }
  };

  const stateOf = (m: CleanupModelInfo): ModelCardState => {
    if (busy?.id === m.id) return { kind: "downloading", label: busy.label, percent: busy.percent };
    if (!installed[m.id]) return { kind: "available" };
    return m.id === current ? { kind: "active" } : { kind: "installed" };
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div role="radiogroup" aria-label="Cleanup model" className="flex flex-col gap-2.5">
        {CLEANUP_MODELS.map((m) => (
          <ModelCard
            key={m.id}
            name={m.name}
            tagline={m.tagline}
            recommended={m.recommended}
            scores={[
              { label: "Quality", value: m.quality, detail: qualityDetail(m) },
              { label: "Speed", value: m.speed, detail: speedDetail(m) },
            ]}
            chips={[{ icon: <Globe className="h-3.5 w-3.5" />, label: "Multilingual" }]}
            sizeMB={m.sizeMB}
            state={stateOf(m)}
            disabled={disabled || (!!busy && busy.id !== m.id)}
            onUse={() => activate(m)}
            onDownload={() => void download(m)}
            onDelete={() => void remove(m)}
          />
        ))}
      </div>
    </TooltipProvider>
  );
}
