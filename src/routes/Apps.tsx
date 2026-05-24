import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Plus,
  AppWindow,
  Trash2,
  Loader2,
  Search,
  CheckCircle2,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/Dialog";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { useAppMappings } from "../lib/store/useAppMappings";
import { useModes } from "../lib/store/useModes";
import { toast } from "../components/ui/Toast";

interface RunningApp {
  exe: string;
  exe_path: string;
  title: string;
  pid: number;
}

const NONE = "__none__";

export default function Apps() {
  const mappings = useAppMappings((s) => s.mappings);
  const addMapping = useAppMappings((s) => s.add);
  const updateMapping = useAppMappings((s) => s.update);
  const removeMapping = useAppMappings((s) => s.remove);
  const modes = useModes((s) => s.modes);

  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <PageContainer>
      <PageHeader
        title="Apps"
        description="Map specific apps to Modes. Without a rule, SuperWisper uses your default Mode."
        actions={
          <Button variant="primary" size="sm" onClick={() => setPickerOpen(true)}>
            <Plus className="h-4 w-4" />
            Add app
          </Button>
        }
      />

      <div className="rounded-md border border-border-subtle bg-bg-elevated/40 px-4 py-3 text-xs text-text-secondary">
        <span className="font-medium text-text-primary">Heads up:</span> the
        common-app names below are guesses. If a rule doesn't trigger, the real
        executable on your PC is probably different. Open the app you want to map,
        then press <span className="font-medium text-text-primary">Add app</span>
        {" "}to pick it from your running processes — that always uses the correct
        executable name.
      </div>

      {mappings.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 p-16 pt-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-pill bg-bg-elevated">
              <AppWindow className="h-5 w-5 text-text-muted" strokeWidth={1.5} />
            </div>
            <div className="text-sm font-medium">No app rules yet</div>
            <div className="max-w-sm text-xs text-text-muted">
              Pick an app you use often and assign it a Mode. SuperWisper will switch
              tone automatically based on which window is focused.
            </div>
            <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add your first app
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-xs text-text-muted">
                  <th className="px-5 py-3 text-left font-medium">App</th>
                  <th className="px-5 py-3 text-left font-medium">Executable</th>
                  <th className="px-5 py-3 text-left font-medium">Mode</th>
                  <th className="px-5 py-3 text-left font-medium">Title regex (optional)</th>
                  <th className="w-12" />
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => (
                  <tr key={m.id} className="border-b border-border-subtle last:border-b-0">
                    <td className="px-5 py-2">
                      <Input
                        value={m.appDisplayName}
                        onChange={(e) =>
                          updateMapping(m.id, { appDisplayName: e.target.value })
                        }
                        className="h-8 border-transparent bg-transparent px-2"
                      />
                    </td>
                    <td className="px-5 py-2 font-mono text-xs text-text-secondary">
                      <Input
                        value={m.appExecutable}
                        onChange={(e) =>
                          updateMapping(m.id, { appExecutable: e.target.value })
                        }
                        className="h-8 border-transparent bg-transparent px-2 font-mono"
                      />
                    </td>
                    <td className="px-5 py-2">
                      <Select
                        value={m.modeId ?? NONE}
                        onValueChange={(v) =>
                          updateMapping(m.id, { modeId: v === NONE ? null : v })
                        }
                      >
                        <SelectTrigger className="h-8 w-44">
                          <SelectValue placeholder="Default" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>(default Mode)</SelectItem>
                          {modes.map((mode) => (
                            <SelectItem key={mode.id} value={mode.id}>
                              {mode.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-5 py-2">
                      <Input
                        value={m.matchWindowTitle ?? ""}
                        onChange={(e) =>
                          updateMapping(m.id, {
                            matchWindowTitle: e.target.value || null,
                          })
                        }
                        className="h-8 border-transparent bg-transparent px-2 font-mono text-xs"
                        placeholder="—"
                      />
                    </td>
                    <td className="px-5 py-2 text-right">
                      <IconButton
                        size="sm"
                        onClick={() => removeMapping(m.id)}
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

      <AppPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        existingExes={new Set(mappings.map((m) => m.appExecutable))}
        onPick={(app) => {
          addMapping({
            appExecutable: app.exe,
            appDisplayName: app.exe.replace(/\.exe$/i, "") || app.exe,
            modeId: null,
          });
          setPickerOpen(false);
          toast.success(`Added ${app.exe}`);
        }}
      />
    </PageContainer>
  );
}

function AppPickerDialog({
  open,
  onOpenChange,
  existingExes,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existingExes: Set<string>;
  onPick: (app: RunningApp) => void;
}) {
  const [apps, setApps] = useState<RunningApp[] | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    invoke<RunningApp[]>("list_running_apps")
      .then((list) => setApps(list))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open]);

  const filtered = useMemo(() => {
    if (!apps) return [];
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (a) =>
        a.exe.toLowerCase().includes(q) ||
        a.title.toLowerCase().includes(q),
    );
  }, [apps, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add app</DialogTitle>
          <DialogDescription>
            Pick an app from your currently running windows. You can also edit the
            executable name manually after adding.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
          <Input
            placeholder="Search by app or window title…"
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        <div className="mt-4 max-h-80 overflow-y-auto rounded-md border border-border-subtle">
          {loading && (
            <div className="flex items-center justify-center gap-2 p-8 text-xs text-text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Scanning open windows…
            </div>
          )}
          {error && <div className="p-4 text-xs text-danger">{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="p-6 text-center text-xs text-text-muted">
              No matching apps.
            </div>
          )}
          {!loading &&
            filtered.map((a) => {
              const taken = existingExes.has(a.exe.toLowerCase());
              return (
                <button
                  key={`${a.exe}-${a.pid}`}
                  type="button"
                  disabled={taken}
                  onClick={() => onPick(a)}
                  className="flex w-full items-center gap-3 border-b border-border-subtle px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-white/[0.04] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-elevated">
                    <AppWindow className="h-4 w-4 text-text-secondary" strokeWidth={1.5} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{a.exe}</div>
                    <div className="truncate text-xs text-text-muted">{a.title}</div>
                  </div>
                  {taken && (
                    <Badge variant="default" className="gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      Added
                    </Badge>
                  )}
                </button>
              );
            })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
