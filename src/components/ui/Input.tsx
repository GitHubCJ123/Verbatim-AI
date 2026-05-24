import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-border-subtle bg-bg-base px-3 py-1 text-sm text-text-primary placeholder:text-text-muted",
        "transition-colors focus-visible:outline-none focus-visible:border-accent-solid/60 focus-visible:ring-2 focus-visible:ring-accent-solid/20",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
