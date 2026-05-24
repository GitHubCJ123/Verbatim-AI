/**
 * Lightweight UI preferences kept in localStorage. Things in here are
 * boolean knobs and small enums — they don't need a Zustand store.
 */
import {
  isEnabled as autostartIsEnabled,
  enable as autostartEnable,
  disable as autostartDisable,
} from "@tauri-apps/plugin-autostart";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";

const LS_NOTIFY = "sw.notify.success";

export interface AppPreferences {
  notifyOnSuccess: boolean;
}

export function loadPreferences(): AppPreferences {
  return {
    notifyOnSuccess: localStorage.getItem(LS_NOTIFY) === "1",
  };
}

export function setNotifyOnSuccess(v: boolean): void {
  localStorage.setItem(LS_NOTIFY, v ? "1" : "0");
}

export async function isAutostartEnabled(): Promise<boolean> {
  try {
    return await autostartIsEnabled();
  } catch {
    return false;
  }
}

export async function setAutostart(enabled: boolean): Promise<void> {
  if (enabled) await autostartEnable();
  else await autostartDisable();
}

/** Show a desktop notification, requesting permission first if needed. */
export async function notify(title: string, body?: string): Promise<void> {
  let granted = await isPermissionGranted();
  if (!granted) {
    const res = await requestPermission();
    granted = res === "granted";
  }
  if (granted) sendNotification({ title, body });
}
