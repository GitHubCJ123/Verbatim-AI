//! Global hotkey registration with PTT (key down + up) support.
//!
//! The frontend listens for two events emitted on every recognized
//! shortcut state change:
//!
//!   `hotkey:down` { spec: String }
//!   `hotkey:up`   { spec: String }
//!
//! For toggle-style modes the frontend can ignore `up` events.

use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_global_shortcut::{
    GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState,
};

#[derive(Default)]
pub struct HotkeyState {
    pub current: Mutex<Option<Shortcut>>,
}

#[derive(Debug, Clone, Serialize)]
struct HotkeyPayload<'a> {
    spec: &'a str,
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, event: ShortcutEvent) {
    let spec = shortcut.into_string();
    match event.state() {
        ShortcutState::Pressed => {
            let _ = app.emit("hotkey:down", HotkeyPayload { spec: &spec });
        }
        ShortcutState::Released => {
            let _ = app.emit("hotkey:up", HotkeyPayload { spec: &spec });
        }
    }
}

#[tauri::command]
pub fn set_hotkey<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, HotkeyState>,
    spec: String,
) -> Result<(), String> {
    let manager = app.global_shortcut();
    let parsed = Shortcut::from_str(&spec).map_err(|e| format!("Invalid shortcut: {e}"))?;

    // Unregister whatever was active first.
    {
        let mut current = state.current.lock().map_err(|e| e.to_string())?;
        if let Some(prev) = current.take() {
            let _ = manager.unregister(prev);
        }
    }

    manager
        .register(parsed.clone())
        .map_err(|e| format!("Failed to register shortcut: {e}"))?;

    let mut current = state.current.lock().map_err(|e| e.to_string())?;
    *current = Some(parsed);
    Ok(())
}

#[tauri::command]
pub fn clear_hotkey<R: Runtime>(app: AppHandle<R>, state: State<'_, HotkeyState>) -> Result<(), String> {
    let manager = app.global_shortcut();
    let mut current = state.current.lock().map_err(|e| e.to_string())?;
    if let Some(prev) = current.take() {
        manager.unregister(prev).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Register the default Ctrl+Space shortcut at startup. Idempotent.
pub fn install_default<R: Runtime>(app: &AppHandle<R>) {
    let Ok(parsed) = Shortcut::from_str("CommandOrControl+Space") else {
        return;
    };
    if app.global_shortcut().register(parsed.clone()).is_ok() {
        if let Some(state) = app.try_state::<HotkeyState>() {
            if let Ok(mut current) = state.current.lock() {
                *current = Some(parsed);
            }
        }
    }
}
