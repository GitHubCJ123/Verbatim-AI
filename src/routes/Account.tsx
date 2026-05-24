import { Card, CardContent } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Avatar, AvatarFallback } from "../components/ui/Avatar";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";

export default function Account() {
  return (
    <PageContainer>
      <PageHeader title="Account" description="Sign in to sync settings, modes, and history across devices." />
      <Card>
        <CardContent className="flex flex-col items-center gap-5 p-12 pt-12 text-center">
          <Avatar className="h-16 w-16">
            <AvatarFallback className="text-base">?</AvatarFallback>
          </Avatar>
          <div>
            <div className="text-base font-semibold">You're in local mode</div>
            <div className="mt-1 max-w-sm text-xs text-text-secondary">
              Your data is stored only on this device. Sign in to enable Supabase sync.
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" size="sm">Sign in</Button>
            <Button variant="ghost" size="sm">Create account</Button>
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
