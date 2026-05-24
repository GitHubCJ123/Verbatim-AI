import { create } from "zustand";

export type RecordingState =
  | "idle"
  | "recording"
  | "processing"
  | "polishing"
  | "success"
  | "error";

interface RecordingStore {
  state: RecordingState;
  modeName: string;
  durationMs: number;
  errorMessage: string | null;
  setState: (s: RecordingState) => void;
  setDuration: (ms: number) => void;
  setMode: (name: string) => void;
  setError: (msg: string | null) => void;
  reset: () => void;
}

export const useRecording = create<RecordingStore>((set) => ({
  state: "idle",
  modeName: "Default",
  durationMs: 0,
  errorMessage: null,
  setState: (state) => set({ state }),
  setDuration: (durationMs) => set({ durationMs }),
  setMode: (modeName) => set({ modeName }),
  setError: (errorMessage) => set({ errorMessage, state: errorMessage ? "error" : "idle" }),
  reset: () => set({ state: "idle", durationMs: 0, errorMessage: null }),
}));
