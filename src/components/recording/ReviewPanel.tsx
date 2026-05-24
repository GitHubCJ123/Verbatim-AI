import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ClipboardCopy, X, RotateCw, Send } from "lucide-react";
import { cn } from "../../lib/utils";

interface ReviewPanelProps {
  modeName: string;
  initialText: string;
  /** Streamed updates while polishing. */
  streamingText?: string;
  isPolishing: boolean;
  onPaste: (text: string) => void;
  onCopy: (text: string) => void;
  onDiscard: () => void;
  onRegenerate: () => void;
}

export function ReviewPanel({
  modeName,
  initialText,
  streamingText,
  isPolishing,
  onPaste,
  onCopy,
  onDiscard,
  onRegenerate,
}: ReviewPanelProps) {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Mirror streaming chunks until the user starts editing manually.
  const userEditedRef = useRef(false);
  useEffect(() => {
    if (!userEditedRef.current && streamingText !== undefined) {
      setText(streamingText);
    }
  }, [streamingText]);

  useEffect(() => {
    // Autofocus when polishing finishes.
    if (!isPolishing) textareaRef.current?.focus();
  }, [isPolishing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onPaste(text);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDiscard();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [text, onPaste, onDiscard]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 240, damping: 26 }}
      className="pointer-events-auto flex h-full w-full flex-col gap-3 rounded-lg2 border border-white/10 bg-[rgba(20,20,28,0.85)] p-4 shadow-md backdrop-blur-2xl"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-text-primary">Review</span>
          <span className="rounded-pill border border-border-subtle bg-bg-elevated px-2 py-0.5 text-[10px] text-text-secondary">
            {modeName}
          </span>
        </div>
        {isPolishing && (
          <span className="text-[10px] text-text-muted">Polishing…</span>
        )}
      </div>

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => {
          userEditedRef.current = true;
          setText(e.target.value);
        }}
        className={cn(
          "flex-1 resize-none rounded-md border border-border-subtle bg-bg-base px-3 py-2 font-sans text-sm leading-relaxed text-text-primary",
          "focus:outline-none focus:border-accent-solid/60 focus:ring-2 focus:ring-accent-solid/20",
        )}
        placeholder={isPolishing ? "Listening for tokens…" : "Cleaned text will appear here"}
      />

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onDiscard}
            className="flex h-8 items-center gap-1 rounded-md px-2.5 text-xs text-text-secondary transition-colors hover:bg-white/[0.04] hover:text-text-primary"
          >
            <X className="h-3.5 w-3.5" />
            Discard
          </button>
          <button
            type="button"
            onClick={onRegenerate}
            disabled={isPolishing}
            className="flex h-8 items-center gap-1 rounded-md px-2.5 text-xs text-text-secondary transition-colors hover:bg-white/[0.04] hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
          >
            <RotateCw className="h-3.5 w-3.5" />
            Regenerate
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onCopy(text)}
            disabled={isPolishing || !text}
            className="flex h-8 items-center gap-1 rounded-md border border-border-subtle bg-bg-elevated px-2.5 text-xs text-text-primary transition-colors hover:border-border-strong disabled:pointer-events-none disabled:opacity-50"
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
            Copy
          </button>
          <button
            type="button"
            onClick={() => onPaste(text)}
            disabled={isPolishing || !text}
            className="flex h-8 items-center gap-1.5 rounded-md bg-gradient-to-b from-accent-solid to-[#7c3aed] px-3 text-xs font-medium text-white shadow-sm transition-all hover:brightness-110 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            Paste
          </button>
        </div>
      </div>
    </motion.div>
  );
}
