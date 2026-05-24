import { Plus, BookText } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";

export default function Vocabulary() {
  return (
    <PageContainer>
      <PageHeader
        title="Vocabulary"
        description="Specialized terms so proper nouns stay spelled correctly."
        actions={
          <Button variant="primary" size="sm">
            <Plus className="h-4 w-4" />
            Add term
          </Button>
        }
      />
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 p-16 pt-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-pill bg-bg-elevated">
            <BookText className="h-5 w-5 text-text-muted" strokeWidth={1.5} />
          </div>
          <div className="text-sm font-medium">No custom terms</div>
          <div className="max-w-sm text-xs text-text-muted">
            Add product names, people, or jargon you use often. They'll be injected into every cleanup prompt.
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
