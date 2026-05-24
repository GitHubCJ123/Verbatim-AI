import { useEffect, useState } from "react";
import { toast } from "../components/ui/Toast";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/Tabs";
import { Card, CardContent } from "../components/ui/Card";
import { Switch } from "../components/ui/Switch";
import { Button } from "../components/ui/Button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/Select";
import { HotkeyRecorder } from "../components/settings/HotkeyRecorder";
import { applyHotkey, loadHotkeyConfig, saveHotkeyConfig } from "../lib/hotkey";
import {
  isAutostartEnabled,
  loadPreferences,
  setAutostart,
  setNotifyOnSuccess,
} from "../lib/preferences";
import { useOnboarding } from "../lib/store/useOnboarding";
import { getActiveProvider } from "../lib/ai";
import { useTheme, type Theme } from "../lib/theme";
import {
  loadOverlayPosition,
  setOverlayPosition,
  type OverlayPosition,
  isClipboardRestoreEnabled,
  setClipboardRestore,
} from "../lib/preferences";

interface RowProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

function SettingRow({ title, description, children }: RowProps) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border-subtle py-4 last:border-b-0">
      <div className="flex flex-col gap-0.5">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-text-muted">{description}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ThemeSelect() {
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.set);
  return (
    <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
      <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="dark">Dark</SelectItem>
        <SelectItem value="light">Light</SelectItem>
        <SelectItem value="system">Match system</SelectItem>
      </SelectContent>
    </Select>
  );
}

function OverlayPositionSelect() {
  const [v, setV] = useState<OverlayPosition>(loadOverlayPosition());
  return (
    <Select
      value={v}
      onValueChange={(next) => {
        const np = next as OverlayPosition;
        setOverlayPosition(np);
        setV(np);
      }}
    >
      <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="bottom-center">Bottom center</SelectItem>
        <SelectItem value="top-center">Top center</SelectItem>
        <SelectItem value="bottom-right">Bottom right</SelectItem>
        <SelectItem value="top-right">Top right</SelectItem>
        <SelectItem value="bottom-left">Bottom left</SelectItem>
        <SelectItem value="top-left">Top left</SelectItem>
      </SelectContent>
    </Select>
  );
}

function ClipboardRestoreSwitch() {
  const [on, setOn] = useState(isClipboardRestoreEnabled());
  return (
    <Switch
      checked={on}
      onCheckedChange={(v) => {
        setClipboardRestore(v);
        setOn(v);
      }}
    />
  );
}

export default function Settings() {
  const [hotkey, setHotkey] = useState(() => loadHotkeyConfig());
  const [autostart, setAutostartState] = useState(false);
  const [notifyOnSuccess, setNotifyState] = useState(() => loadPreferences().notifyOnSuccess);

  useEffect(() => {
    saveHotkeyConfig(hotkey);
  }, [hotkey]);

  useEffect(() => {
    void isAutostartEnabled().then(setAutostartState);
  }, []);

  const handleHotkeyChange = async (spec: string) => {
    try {
      await applyHotkey(spec);
      setHotkey((h) => ({ ...h, spec }));
      toast.success("Hotkey updated", { description: `Now using ${spec}` });
    } catch (e) {
      toast.error("Couldn't register that shortcut", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <PageContainer>
      <PageHeader title="Settings" description="Configure SuperWisper to fit your workflow." />
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="recording">Recording</TabsTrigger>
          <TabsTrigger value="overlay">Overlay</TabsTrigger>
          <TabsTrigger value="privacy">Privacy</TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow title="Launch at startup" description="Open SuperWisper when Windows starts.">
                <Switch
                  checked={autostart}
                  onCheckedChange={async (v) => {
                    try {
                      await setAutostart(v);
                      setAutostartState(v);
                    } catch (e) {
                      toast.error("Couldn't update autostart", {
                        description: e instanceof Error ? e.message : String(e),
                      });
                    }
                  }}
                />
              </SettingRow>
              <SettingRow
                title="Notify on transcribe"
                description="Show a system notification after each successful transcription."
              >
                <Switch
                  checked={notifyOnSuccess}
                  onCheckedChange={(v) => {
                    setNotifyOnSuccess(v);
                    setNotifyState(v);
                  }}
                />
              </SettingRow>
              <SettingRow title="Theme" description="Match Windows or pick light/dark.">
                <ThemeSelect />
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="recording">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow title="Global hotkey" description="Hold to dictate from anywhere.">
                <HotkeyRecorder value={hotkey.spec} onChange={handleHotkeyChange} />
              </SettingRow>
              <SettingRow title="Push-to-talk" description="Hold to record. Off = tap to toggle.">
                <Switch
                  checked={hotkey.pushToTalk}
                  onCheckedChange={(checked) =>
                    setHotkey((h) => ({ ...h, pushToTalk: checked }))
                  }
                />
              </SettingRow>
              <SettingRow title="Noise suppression" description="Filter background noise during recording.">
                <Switch defaultChecked />
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="overlay">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow title="Position" description="Where the recording pill appears.">
                <OverlayPositionSelect />
              </SettingRow>
              <SettingRow
                title="Restore clipboard after paste"
                description="When on, SuperWisper remembers whatever you had on the clipboard before dictating, pastes the cleaned text, then puts your original content back ~1 second later. Off by default — Windows already keeps clipboard history (press Win+V to view it), so the cleaned text just stays on the clipboard."
              >
                <ClipboardRestoreSwitch />
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="privacy">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow title="Anonymous telemetry" description="Help improve SuperWisper. Never your transcript content.">
                <Switch />
              </SettingRow>
              <SettingRow title="History retention" description="Auto-delete old transcripts.">
                <Select defaultValue="forever">
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="forever">Forever</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="7">7 days</SelectItem>
                    <SelectItem value="off">Off</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="advanced">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow title="Log level" description="Verbosity of log files.">
                <Select defaultValue="info">
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="error">Error</SelectItem>
                    <SelectItem value="warn">Warn</SelectItem>
                    <SelectItem value="info">Info</SelectItem>
                    <SelectItem value="debug">Debug</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow
                title="Test AI connection"
                description="Sends a ping to the Supabase cleanup function. Tells you whether the network path works."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    const provider = getActiveProvider();
                    if (!provider) {
                      toast.error("No provider configured");
                      return;
                    }
                    toast.info("Pinging…");
                    const h = await provider.health();
                    if (h.ok) {
                      toast.success(`Connected (${h.latencyMs ?? "?"} ms)`);
                    } else {
                      toast.error("Connection failed", {
                        description: h.message ?? "Unknown",
                        duration: 12000,
                      });
                    }
                  }}
                >
                  Test
                </Button>
              </SettingRow>
              <SettingRow
                title="Re-run onboarding"
                description="Walk through the welcome flow again to reconfigure tone presets."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    useOnboarding.getState().reset();
                    window.location.reload();
                  }}
                >
                  Restart
                </Button>
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
