import { Toaster as SonnerToaster } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "group toast !bg-bg-glass !text-text-primary !border-border-subtle !backdrop-blur-xl !shadow-md",
          description: "group-[.toast]:text-text-secondary",
          actionButton: "group-[.toast]:!bg-accent-solid group-[.toast]:!text-white",
          cancelButton: "group-[.toast]:!bg-bg-elevated group-[.toast]:!text-text-secondary",
        },
      }}
    />
  );
}

export { toast } from "sonner";
