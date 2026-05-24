import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const Kbd = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <kbd
      ref={ref}
      className={cn(
        "inline-flex h-5 min-w-[20px] items-center justify-center rounded-sm border border-border-strong bg-bg-elevated px-1.5 font-mono text-[10px] font-medium text-text-secondary shadow-sm",
        className,
      )}
      {...props}
    />
  ),
);
Kbd.displayName = "Kbd";
