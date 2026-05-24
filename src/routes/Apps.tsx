import { Plus, AppWindow } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";

export default function Apps() {
  return (
    <PageContainer>
      <PageHeader
        title="Apps"
        description="Map specific apps to Modes. Without a rule, SuperWisper uses your default Mode."
        actions={
          <Button variant="primary" size="sm">
            <Plus className="h-4 w-4" />
            Add app
          </Button>
        }
      />
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 p-16 pt-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-pill bg-bg-elevated">
            <AppWindow className="h-5 w-5 text-text-muted" strokeWidth={1.5} />
          </div>
          <div className="text-sm font-medium">No app rules yet</div>
          <div className="max-w-sm text-xs text-text-muted">
            SuperWisper will use your default Mode in every app. Add a rule to switch tone automatically based on which window is focused.
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
