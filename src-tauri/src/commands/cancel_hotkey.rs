//! Cancel-during-recording global shortcut
//! (docs/proposals/handy-adoption.md §Hotkey handling,
//! docs/improvement-plan/03-single-key-hotkey.md).
//!
//! While a dictation is in progress the frontend arms a global
//! `Escape` shortcut through [`enable_cancel_shortcut`]; releasing it
//! again through [`disable_cancel_shortcut`] when recording ends. The
//! global-shortcut plugin's shared handler routes a press of the armed
//! shortcut to a `hotkey:cancel` event (see [`crate::commands::hotkey::handle_event`]),
//! which the frontend turns into a discard (no audio saved, overlay
//! hidden, nothing pasted).
//!
//! Escape is only registered *during* recording so it reaches the
//! foreground app normally the rest of the time. The registration is
//! separate from the primary hotkey ([`crate::commands::hotkey::HotkeyState`]),
//! so arming/disarming cancel never disturbs the main shortcut.

use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

/// Shortcut spec used to cancel an in-progress recording.
pub const CANCEL_SPEC: &str = "Escape";

#[derive(Default)]
pub struct CancelHotkeyState {
    /// The armed cancel shortcut, if any. `None` when not recording.
    pub current: Mutex<Option<Shortcut>>,
}

/// True when `shortcut` is the currently-armed cancel shortcut. Used by
/// the shared plugin handler to route Escape presses to `hotkey:cancel`
/// instead of the normal `hotkey:down` / `hotkey:up` pipeline.
pub fn matches<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut) -> bool {
    let Some(state) = app.try_state::<CancelHotkeyState>() else {
        return false;
    };
    let Ok(guard) = state.current.lock() else {
        return false;
    };
    guard.as_ref() == Some(shortcut)
}

/// Arm the global cancel shortcut (Escape). Idempotent — arming while
/// already armed is a no-op. Called by the recording bridge when a
/// dictation starts.
#[tauri::command]
pub fn enable_cancel_shortcut<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CancelHotkeyState>,
) -> Result<(), String> {
    let parsed = Shortcut::from_str(CANCEL_SPEC)
        .map_err(|e| format!("Invalid cancel shortcut: {e}"))?;

    {
        let current = state.current.lock().map_err(|e| e.to_string())?;
        if current.as_ref() == Some(&parsed) {
            return Ok(());
        }
    }

    let manager = app.global_shortcut();
    // Clear any stale registration (hot-reload / prior process) first.
    let _ = manager.unregister(parsed.clone());
    if let Err(e) = manager.register(parsed.clone()) {
        let msg = e.to_string();
        // "Already registered" means the end state we want already holds.
        if !msg.contains("already registered") {
            return Err(format!("Failed to arm cancel shortcut: {msg}"));
        }
    }

    let mut current = state.current.lock().map_err(|e| e.to_string())?;
    *current = Some(parsed);
    Ok(())
}

/// Disarm the global cancel shortcut so Escape reaches the foreground
/// app again. Idempotent. Called by the recording bridge on stop and on
/// cancel (every terminal recording path), so Escape never lingers.
#[tauri::command]
pub fn disable_cancel_shortcut<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CancelHotkeyState>,
) -> Result<(), String> {
    let mut current = state.current.lock().map_err(|e| e.to_string())?;
    if let Some(prev) = current.take() {
        let _ = app.global_shortcut().unregister(prev);
    }
    Ok(())
}
