import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "../components/ui/Toast";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/Tabs";
import { Card, CardContent } from "../components/ui/Card";
import { Switch } from "../components/ui/Switch";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/Select";
import { HotkeyRecorder } from "../components/settings/HotkeyRecorder";
import { applyHotkey, loadHotkeyConfig, saveHotkeyConfig } from "../lib/hotkey";
import {
  AzureFoundryProvider,
  isConfigured,
  loadAzureConfig,
  saveAzureConfig,
  type AzureConfig,
} from "../lib/ai";

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

export default function Settings() {
  const [hotkey, setHotkey] = useState(() => loadHotkeyConfig());
  const [azure, setAzure] = useState<Partial<AzureConfig>>(() => loadAzureConfig());
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    saveHotkeyConfig(hotkey);
  }, [hotkey]);

  useEffect(() => {
    saveAzureConfig(azure);
  }, [azure]);

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

  const testConnection = async () => {
    if (!isConfigured(azure)) {
      toast.error("Fill in all four fields first.");
      return;
    }
    setTesting(true);
    try {
      const provider = new AzureFoundryProvider(azure);
      const health = await provider.health();
      if (health.ok) {
        toast.success("Connected to Azure", {
          description: health.latencyMs ? `${health.latencyMs} ms round trip` : undefined,
        });
      } else {
        toast.error("Couldn't reach Azure", { description: health.message });
      }
    } catch (e) {
      toast.error("Test failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
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
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="privacy">Privacy</TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow title="Launch at startup" description="Open SuperWisper when Windows starts.">
                <Switch defaultChecked />
              </SettingRow>
              <SettingRow title="Theme" description="Currently only dark is available.">
                <Select defaultValue="dark">
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="light" disabled>Light (soon)</SelectItem>
                  </SelectContent>
                </Select>
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
                <Select defaultValue="bottom-center">
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bottom-center">Bottom center</SelectItem>
                    <SelectItem value="top-center">Top center</SelectItem>
                    <SelectItem value="bottom-right">Bottom right</SelectItem>
                    <SelectItem value="top-right">Top right</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ai">
          <Card>
            <CardContent className="p-5 pt-5">
              <SettingRow title="Azure endpoint" description="https://your-resource.openai.azure.com">
                <Input
                  placeholder="https://…"
                  className="w-80"
                  value={azure.endpoint ?? ""}
                  onChange={(e) => setAzure((a) => ({ ...a, endpoint: e.target.value }))}
                />
              </SettingRow>
              <SettingRow title="API key" description="Stored locally. Moves to OS keyring later.">
                <Input
                  type="password"
                  placeholder="•••••••••••••"
                  className="w-80"
                  value={azure.apiKey ?? ""}
                  onChange={(e) => setAzure((a) => ({ ...a, apiKey: e.target.value }))}
                />
              </SettingRow>
              <SettingRow title="Transcription deployment" description="The Whisper-equivalent deployment name.">
                <Input
                  placeholder="whisper-1"
                  className="w-80"
                  value={azure.transcribeDeployment ?? ""}
                  onChange={(e) =>
                    setAzure((a) => ({ ...a, transcribeDeployment: e.target.value }))
                  }
                />
              </SettingRow>
              <SettingRow title="Cleanup deployment" description="The chat model used to polish transcripts.">
                <Input
                  placeholder="gpt-4o-mini"
                  className="w-80"
                  value={azure.cleanupDeployment ?? ""}
                  onChange={(e) =>
                    setAzure((a) => ({ ...a, cleanupDeployment: e.target.value }))
                  }
                />
              </SettingRow>
              <div className="flex items-center justify-between gap-6 pt-4">
                <div className="flex items-center gap-2 text-xs">
                  {isConfigured(azure) ? (
                    <Badge variant="success">Configured</Badge>
                  ) : (
                    <Badge variant="warning">Missing fields</Badge>
                  )}
                  <span className="text-text-muted">
                    Credentials are saved locally and never leave your machine except to call Azure.
                  </span>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={testConnection}
                  disabled={testing || !isConfigured(azure)}
                >
                  {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Test connection
                </Button>
              </div>
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
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
