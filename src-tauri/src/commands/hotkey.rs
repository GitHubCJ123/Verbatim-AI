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

/// Register `spec` as the active global shortcut.
///
/// `spec` may be a modifier + key combo (e.g. `"CommandOrControl+Space"`)
/// *or* a single key with no modifier (e.g. `"F6"`). Single-key specs —
/// function keys in particular — parse and register the same way on every
/// platform, so no special handling is needed here.
///
/// Note: the raw `Fn` key is handled in hardware/firmware on most laptops
/// and never reaches the OS as a key code, so it cannot be captured or
/// registered as a global shortcut. Recommend a function key like `F6`
/// where `Fn` can't be bound.
#[tauri::command]
pub fn set_hotkey<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, HotkeyState>,
    spec: String,
) -> Result<(), String> {
    let manager = app.global_shortcut();
    let parsed = Shortcut::from_str(&spec).map_err(|e| format!("Invalid shortcut: {e}"))?;

    // Idempotent: if the same shortcut is already current, no-op.
    {
        let current = state.current.lock().map_err(|e| e.to_string())?;
        if let Some(prev) = current.as_ref() {
            if *prev == parsed {
                return Ok(());
            }
        }
    }

    // Unregister whatever was active first.
    {
        let mut current = state.current.lock().map_err(|e| e.to_string())?;
        if let Some(prev) = current.take() {
            let _ = manager.unregister(prev);
        }
    }

    // Also try to unregister the *new* shortcut in case it's lingering
    // from a stale registration (hot-reload, prior process, etc.).
    let _ = manager.unregister(parsed.clone());

    match manager.register(parsed.clone()) {
        Ok(()) => {}
        Err(e) => {
            // "Already registered" can happen if the plugin's internal map
            // still thinks it owns the shortcut even after our unregister.
            // Treat it as success — the end state (this spec active) is
            // what the user wanted.
            let msg = e.to_string();
            if !msg.contains("already registered") {
                return Err(format!("Failed to register shortcut: {msg}"));
            }
        }
    }

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
