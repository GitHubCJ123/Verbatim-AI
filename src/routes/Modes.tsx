import { Plus, MessageSquare, Mail, Code, FileText, Languages, Sparkles } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";

const placeholderModes = [
  { name: "Default", description: "Universal cleanup, preserves tone.", icon: Sparkles, style: "Auto-paste" },
  { name: "Formal Email", description: "Professional sentences.", icon: Mail, style: "Auto-paste" },
  { name: "Slack Message", description: "Casual, contractions ok.", icon: MessageSquare, style: "Auto-paste" },
  { name: "Code Comment", description: "Concise, imperative.", icon: Code, style: "Auto-paste" },
  { name: "Notes", description: "Bullet brain-dump.", icon: FileText, style: "Review" },
  { name: "Translate → English", description: "Any language to English.", icon: Languages, style: "Auto-paste" },
];

export default function Modes() {
  return (
    <PageContainer>
      <PageHeader
        title="Modes"
        description="Reusable presets for cleanup, language, and output behavior."
        actions={
          <Button variant="primary" size="sm">
            <Plus className="h-4 w-4" />
            New Mode
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {placeholderModes.map((m) => (
          <Card
            key={m.name}
            className="group cursor-pointer transition-all hover:border-border-strong hover:bg-bg-elevated/80"
          >
            <CardContent className="flex flex-col gap-3 p-5 pt-5">
              <div className="flex items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-bg-elevated text-text-primary">
                  <m.icon className="h-4 w-4" strokeWidth={1.75} />
                </div>
                <Badge variant={m.style === "Review" ? "warning" : "accent"}>{m.style}</Badge>
              </div>
              <div>
                <div className="text-sm font-semibold">{m.name}</div>
                <div className="mt-0.5 text-xs text-text-secondary">{m.description}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </PageContainer>
  );
}
