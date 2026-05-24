/**
 * Feedback dialog. Writes a row to `public.feedback`.
 */
import { useState } from "react";
import { MessageSquarePlus, Loader2, Star } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/Select";
import { cn } from "../../lib/utils";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/store/useAuth";
import { toast } from "../ui/Toast";

const CATEGORIES = [
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature request" },
  { value: "ui", label: "UI / design" },
  { value: "ai", label: "Transcription / AI quality" },
  { value: "other", label: "Other" },
];

interface Props {
  trigger?: React.ReactNode;
}

export function FeedbackDialog({ trigger }: Props) {
  const user = useAuth((s) => s.user);
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [category, setCategory] = useState<string>("other");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!message.trim()) {
      toast.error("Write something first");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.from("feedback").insert({
        user_id: user?.id ?? null,
        email: user?.email ?? null,
        rating,
        category,
        message: message.trim(),
        app_version: (import.meta.env.VITE_APP_VERSION as string | undefined) ?? null,
      });
      if (error) throw new Error(error.message);
      toast.success("Thanks — feedback received");
      setMessage("");
      setRating(null);
      setCategory("other");
      setOpen(false);
    } catch (e) {
      toast.error("Couldn't submit feedback", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <button className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary">
            <MessageSquarePlus className="h-3.5 w-3.5" />
            Send feedback
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Bug, idea, gripe — all welcome. We read every one.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div>
            <div className="mb-1.5 text-xs text-text-secondary">How's the app?</div>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(rating === n ? null : n)}
                  className="rounded-md p-1 transition-colors hover:bg-bg-elevated"
                  aria-label={`${n} star${n === 1 ? "" : "s"}`}
                >
                  <Star
                    className={cn(
                      "h-5 w-5",
                      rating !== null && n <= rating
                        ? "fill-warning text-warning"
                        : "text-text-muted",
                    )}
                    strokeWidth={1.5}
                  />
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-xs text-text-secondary">Category</div>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="mb-1.5 text-xs text-text-secondary">Message</div>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              placeholder="What happened, what you expected, screenshots welcome…"
              autoFocus
            />
          </div>

          {user?.email && (
            <div className="text-[10px] text-text-muted">
              Sending as {user.email}.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={busy || !message.trim()}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
