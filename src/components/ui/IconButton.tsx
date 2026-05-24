import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: "sm" | "md" | "lg";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, size = "md", ...props }, ref) => {
    const sizes = {
      sm: "h-7 w-7",
      md: "h-8 w-8",
      lg: "h-10 w-10",
    };
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "inline-flex items-center justify-center rounded-md text-text-secondary",
          "transition-all hover:bg-bg-elevated hover:text-text-primary active:scale-[0.96]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-solid/40",
          "disabled:pointer-events-none disabled:opacity-50",
          sizes[size],
          className,
        )}
        {...props}
      />
    );
  },
);
IconButton.displayName = "IconButton";
