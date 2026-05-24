import { forwardRef } from "react";
import * as TogglePrimitive from "@radix-ui/react-toggle";
import { cn } from "../../lib/utils";

export const Toggle = forwardRef<
  React.ElementRef<typeof TogglePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root>
>(({ className, ...props }, ref) => (
  <TogglePrimitive.Root
    ref={ref}
    className={cn(
      "inline-flex h-8 items-center justify-center rounded-md border border-border-subtle bg-transparent px-3 text-sm text-text-secondary",
      "transition-all hover:bg-bg-elevated hover:text-text-primary",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-solid/40",
      "data-[state=on]:border-accent-solid/40 data-[state=on]:bg-accent-solid/10 data-[state=on]:text-text-primary",
      "disabled:pointer-events-none disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Toggle.displayName = "Toggle";
