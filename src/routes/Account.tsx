import { useEffect, useState } from "react";
import { LogOut, Loader2, ImagePlus } from "lucide-react";
import { Card, CardContent } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/Avatar";
import { Badge } from "../components/ui/Badge";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { useAuth } from "../lib/store/useAuth";
import { useProfile, initials } from "../lib/store/useProfile";
import { toast } from "../components/ui/Toast";

interface RowProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

function Row({ title, description, children }: RowProps) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border-subtle py-4 last:border-b-0">
      <div className="flex flex-col gap-0.5">
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="text-xs text-text-muted">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export default function Account() {
  const user = useAuth((s) => s.user)!;
  const signOut = useAuth((s) => s.signOut);
  const profile = useProfile((s) => s.profile);
  const updateProfile = useProfile((s) => s.update);

  const [displayName, setDisplayName] = useState(profile?.display_name ?? "");
  const [avatarUrl, setAvatarUrl] = useState(profile?.avatar_url ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDisplayName(profile?.display_name ?? "");
    setAvatarUrl(profile?.avatar_url ?? "");
  }, [profile?.display_name, profile?.avatar_url]);

  const dirty =
    (displayName || "") !== (profile?.display_name ?? "") ||
    (avatarUrl || "") !== (profile?.avatar_url ?? "");

  const save = async () => {
    setSaving(true);
    try {
      await updateProfile({
        display_name: displayName.trim() || null,
        avatar_url: avatarUrl.trim() || null,
      });
      toast.success("Profile updated");
    } catch (e) {
      toast.error("Couldn't save", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Account"
        description="Manage your profile. Your transcripts sync to the cloud automatically."
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut().then(() => toast.success("Signed out"))}
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </Button>
        }
      />

      {/* Profile card */}
      <Card>
        <CardContent className="flex flex-col gap-6 p-6 pt-6">
          <div className="flex items-center gap-5">
            <Avatar className="h-20 w-20">
              {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
              <AvatarFallback className="text-2xl">{initials()}</AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <div className="text-lg font-semibold">
                {profile?.display_name || user.email?.split("@")[0] || "Welcome"}
              </div>
              <div className="text-xs text-text-secondary">{user.email}</div>
              <div className="mt-2 flex items-center gap-2">
                <Badge variant="success">Signed in</Badge>
                <span className="text-[10px] text-text-muted">
                  id: {user.id.slice(0, 8)}…
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col">
            <Row title="Display name" description="Shown in the top bar and sidebar.">
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="w-72"
              />
            </Row>
            <Row title="Email" description="Sign-in address. Change via your provider.">
              <Input value={user.email ?? ""} disabled className="w-72" />
            </Row>
            <Row
              title="Avatar URL"
              description="Optional image link. We'll upgrade to upload in a later pass."
            >
              <div className="flex items-center gap-2">
                <ImagePlus className="h-3.5 w-3.5 text-text-muted" />
                <Input
                  value={avatarUrl}
                  onChange={(e) => setAvatarUrl(e.target.value)}
                  placeholder="https://…"
                  className="w-72"
                />
              </div>
            </Row>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDisplayName(profile?.display_name ?? "");
                setAvatarUrl(profile?.avatar_url ?? "");
              }}
              disabled={!dirty || saving}
            >
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={save} disabled={!dirty || saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save changes
            </Button>
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
