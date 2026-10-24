/**
 * One selectable model in a model list: name, badges, numeric quality/speed
 * scores (with the measured figures on hover), feature chips, size and the
 * download / use / delete actions. Shared by the speech and cleanup lists.
 */
import type { ReactNode } from "react";
import { Check, Download, HardDrive, Loader2, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { ProgressBar } from "../ui/ProgressBar";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/Tooltip";

export interface ModelScore {
  label: string;
  /** 0–10. */
  value: number;
  detail: ReactNode;
}

export type ModelCardState =
  | { kind: "available" }
  | { kind: "downloading"; label: string; percent: number | null }
  | { kind: "installed" }
  | { kind: "active" };

export interface ModelCardProps {
  name: string;
  tagline: string;
  recommended?: boolean;
  scores: ModelScore[];
  chips?: { icon?: ReactNode; label: string }[];
  sizeMB: number;
  state: ModelCardState;
  disabled?: boolean;
  onUse: () => void;
  onDownload: () => void;
  onDelete?: () => void;
}

export function formatSize(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function ScoreRow({ score }: { score: ModelScore }) {
  const pct = Math.max(0, Math.min(10, score.value)) * 10;
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <div
          className="grid cursor-help grid-cols-[3.75rem_1fr_1.75rem] items-center gap-2"
          aria-label={`${score.label} ${score.value.toFixed(1)} out of 10`}
        >
          <span className="text-right text-[11px] text-text-muted">{score.label}</span>
          <span className="h-1.5 overflow-hidden rounded-pill bg-bg-base">
            <span
              className="block h-full rounded-pill bg-gradient-to-r from-accent-start to-accent-end"
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="text-right font-mono text-[11px] tabular-nums text-text-secondary">
            {score.value.toFixed(1)}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[260px] leading-relaxed">
        {score.detail}
      </TooltipContent>
    </Tooltip>
  );
}

export function ModelCard({
  name,
  tagline,
  recommended,
  scores,
  chips = [],
  sizeMB,
  state,
  disabled,
  onUse,
  onDownload,
  onDelete,
}: ModelCardProps) {
  const active = state.kind === "active";
  const installed = state.kind === "installed" || active;
  const selectable = state.kind === "installed" && !disabled;

  return (
    <div
      role="radio"
      aria-checked={active}
      aria-disabled={disabled || undefined}
      tabIndex={selectable ? 0 : -1}
      onClick={() => selectable && onUse()}
      onKeyDown={(e) => {
        if (selectable && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onUse();
        }
      }}
      className={cn(
        "flex flex-col gap-3 rounded-lg border px-4 py-3.5 text-left transition-colors",
        active
          ? "border-accent-solid/60 bg-accent-solid/[0.07]"
          : "border-border-subtle bg-bg-elevated",
        selectable && "cursor-pointer hover:border-border-strong",
        disabled && !active && "opacity-60",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{name}</span>
            {active && (
              <span className="inline-flex items-center gap-1 rounded-pill bg-accent-solid/15 px-2 py-0.5 text-[11px] font-medium text-accent-start">
                <Check className="h-3 w-3" strokeWidth={3} /> Active
              </span>
            )}
            {recommended && (
              <span className="rounded-pill bg-accent-solid/10 px-2 py-0.5 text-[11px] font-medium text-accent-start">
                Recommended
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">{tagline}</p>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-1.5 sm:w-48">
          {scores.map((s) => (
            <ScoreRow key={s.label} score={s} />
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border-subtle pt-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
          {chips.map((c) => (
            <span key={c.label} className="inline-flex items-center gap-1">
              {c.icon}
              {c.label}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          {state.kind === "downloading" ? (
            <span className="inline-flex items-center gap-1 text-text-secondary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {state.label}
              {state.percent !== null ? ` ${state.percent}%` : "…"}
            </span>
          ) : installed ? (
            <>
              <span className="inline-flex items-center gap-1">
                <HardDrive className="h-3.5 w-3.5" /> {formatSize(sizeMB)}
              </span>
              {onDelete && !active && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  className="inline-flex items-center gap-1 text-text-muted hover:text-danger disabled:pointer-events-none"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                onDownload();
              }}
              className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-base px-2 py-1 text-text-secondary hover:border-border-strong disabled:pointer-events-none"
            >
              <Download className="h-3.5 w-3.5" /> Download · {formatSize(sizeMB)}
            </button>
          )}
        </div>
      </div>

      {state.kind === "downloading" && <ProgressBar value={state.percent ?? 0} />}
    </div>
  );
}
