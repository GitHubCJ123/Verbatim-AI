import { History as HistoryIcon } from "lucide-react";
import { Card, CardContent } from "../components/ui/Card";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { Input } from "../components/ui/Input";

export default function History() {
  return (
    <PageContainer>
      <PageHeader title="History" description="Every transcription you've made, searchable." />
      <div className="mb-4 flex items-center gap-2">
        <Input placeholder="Search transcriptions…" className="max-w-sm" />
      </div>
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 p-16 pt-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-pill bg-bg-elevated">
            <HistoryIcon className="h-5 w-5 text-text-muted" strokeWidth={1.5} />
          </div>
          <div className="text-sm font-medium">No history yet</div>
          <div className="max-w-sm text-xs text-text-muted">
            Once you start dictating, your transcriptions will appear here.
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
