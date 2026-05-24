import { Sparkles } from "lucide-react";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Card, CardContent } from "../components/ui/Card";
import { Switch } from "../components/ui/Switch";

export default function ModeEditor() {
  return (
    <PageContainer className="max-w-6xl">
      <PageHeader
        title="Edit Mode"
        description="Configure the cleanup prompt, output, and hotkey for this Mode."
        actions={
          <>
            <Button variant="ghost" size="sm">Cancel</Button>
            <Button variant="primary" size="sm">Save changes</Button>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-6">
        {/* Form column */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardContent className="flex flex-col gap-4 p-5 pt-5">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">Name</label>
                <Input defaultValue="Slack Message" />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">Description</label>
                <Input defaultValue="Casual, contractions ok." />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">System prompt</label>
                <Textarea
                  rows={8}
                  className="font-mono text-xs"
                  defaultValue={`Make it casual but clear. Contractions ok.\nLight emoji if it fits naturally.\nNo greetings or sign-offs.`}
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border-subtle bg-bg-elevated px-4 py-3">
                <div>
                  <div className="text-sm font-medium">Save to history</div>
                  <div className="text-xs text-text-muted">Keep cleaned transcripts in your history.</div>
                </div>
                <Switch defaultChecked />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Preview column */}
        <div className="flex flex-col gap-4">
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 p-10 pt-10 text-center">
              <Sparkles className="h-5 w-5 text-accent-start" />
              <div className="text-sm font-medium">Test this mode</div>
              <div className="max-w-xs text-xs text-text-muted">
                Record a sample to see raw and cleaned output side by side. Coming in Phase 4.
              </div>
              <Button variant="secondary" size="sm" disabled>
                Record sample
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
