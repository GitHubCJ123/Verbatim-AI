/**
 * Imperative, promise-based confirm dialog.
 * Usage: `if (await confirmDialog({ title, message, confirmLabel })) {...}`
 *
 * Renders a single Radix Dialog into a mount node at the document root.
 * Replaces window.confirm() so we never get "localhost says" popups.
 */
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./Dialog";
import { Button } from "./Button";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

let mountRoot: Root | null = null;
let mountNode: HTMLDivElement | null = null;

function getMount(): Root {
  if (mountRoot) return mountRoot;
  mountNode = document.createElement("div");
  mountNode.setAttribute("data-confirm-host", "");
  document.body.appendChild(mountNode);
  mountRoot = createRoot(mountNode);
  return mountRoot;
}

interface HostProps {
  options: ConfirmOptions;
  resolve: (v: boolean) => void;
}

function ConfirmHost({ options, resolve }: HostProps) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!open) {
      // Allow close animation, then resolve as cancel if no decision yet.
      const t = setTimeout(() => resolve(false), 150);
      return () => clearTimeout(t);
    }
  }, [open, resolve]);

  const close = (v: boolean) => {
    setOpen(false);
    setTimeout(() => resolve(v), 120);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{options.title}</DialogTitle>
          {options.message && <DialogDescription>{options.message}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => close(false)}>
            {options.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={options.destructive ? "danger" : "primary"}
            size="sm"
            onClick={() => close(true)}
            autoFocus
          >
            {options.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const root = getMount();
    root.render(
      <ConfirmHost
        options={options}
        resolve={(v) => {
          root.render(<></>);
          resolve(v);
        }}
      />,
    );
  });
}
