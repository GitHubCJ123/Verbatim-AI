/**
 * HotkeyRecorder — focusable widget that captures a keyboard
 * combination from the user and returns its Tauri shortcut spec
 * string (e.g. "CommandOrControl+Space", "Alt+F1").
 */
import { useCallback, useEffect, useState } from "react";
import { Kbd } from "../ui/Kbd";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";

interface HotkeyRecorderProps {
  value: string;
  onChange: (spec: string) => void;
}

const MODIFIER_LABEL: Record<string, string> = {
  CommandOrControl: "Ctrl",
  Control: "Ctrl",
  Shift: "Shift",
  Alt: "Alt",
  Super: "Win",
};

function parts(spec: string): string[] {
  return spec.split("+").map((p) => p.trim()).filter(Boolean);
}

function eventToSpec(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.metaKey) mods.push("Super"); // Win key on Windows, ⌘ on macOS
  if (e.shiftKey) mods.push("Shift");
  if (e.altKey) mods.push("Alt");

  // Ignore pure modifier presses.
  const key = e.key;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta" || key === "OS") {
    return null;
  }

  let mainKey: string;
  if (key === " ") mainKey = "Space";
  else if (key.length === 1) mainKey = key.toUpperCase();
  else if (key.startsWith("Arrow")) mainKey = key.replace("Arrow", "");
  else mainKey = key;

  if (mods.length === 0) return null; // require at least one modifier
  return [...mods, mainKey].join("+");
}

export function HotkeyRecorder({ value, onChange }: HotkeyRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        setPending(null);
        return;
      }
      const spec = eventToSpec(e);
      if (spec) {
        setPending(spec);
        setRecording(false);
        onChange(spec);
      }
    },
    [recording, onChange],
  );

  useEffect(() => {
    if (!recording) return;
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [recording, handleKey]);

  const displayed = pending ?? value;
  const tokens = parts(displayed);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => {
          setRecording(true);
          setPending(null);
        }}
        className={cn(
          "flex h-9 min-w-[160px] items-center justify-center gap-1 rounded-md border px-3 transition-colors",
          recording
            ? "border-accent-solid/60 bg-accent-solid/10 text-accent-start"
            : "border-border-subtle bg-bg-base text-text-primary hover:border-border-strong",
        )}
      >
        {recording ? (
          <span className="text-xs text-text-secondary">Press your shortcut…</span>
        ) : tokens.length === 0 ? (
          <span className="text-xs text-text-muted">No shortcut</span>
        ) : (
          tokens.map((t, i) => (
            <Kbd key={i}>{MODIFIER_LABEL[t] ?? t}</Kbd>
          ))
        )}
      </button>
      {recording && (
        <Button variant="ghost" size="sm" onClick={() => setRecording(false)}>
          Cancel
        </Button>
      )}
    </div>
  );
}
