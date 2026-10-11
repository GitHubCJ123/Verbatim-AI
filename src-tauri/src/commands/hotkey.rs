//! Global hotkey registration with PTT (key down + up) support.
//!
//! The frontend listens for two events emitted on every recognized
//! shortcut state change:
//!
//!   `hotkey:down` { spec: String, sessionId?: number, nativeStarted?: bool }
//!   `hotkey:up`   { spec: String, sessionId?: number, nativeStopped?: bool }
//!
//! For toggle-style modes the frontend can ignore `up` events.
//!
//! Issue #53 (Rust-first push-to-talk hot path): before emitting either
//! event, this calls into `native_audio::notify_ptt_down` /
//! `notify_ptt_up`, which synchronously start/stop native Fast/Instant
//! capture when armed. When it does, `sessionId` + `nativeStarted` /
//! `nativeStopped` are set so the frontend adopts the already-running
//! session instead of starting a second one. When the hot path doesn't
//! apply (Standard mode, not armed, etc.) those fields are simply absent
//! and the existing JS-orchestrated start/stop path runs exactly as before.

use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{
    GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState,
};

use super::native_audio;

#[derive(Default)]
pub struct HotkeyState {
    pub current: Mutex<Option<Shortcut>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyDownPayload<'a> {
    spec: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_started: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyUpPayload<'a> {
    spec: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_stopped: Option<bool>,
}

pub fn handle_event(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    // The cancel shortcut (Escape) is armed only while recording. Route
    // its press to `hotkey:cancel` and never emit down/up for it, so the
    // recording pipeline can discard the in-progress dictation.
    if super::cancel_hotkey::matches(app, shortcut) {
        if let ShortcutState::Pressed = event.state() {
            let _ = app.emit("hotkey:cancel", ());
        }
        return;
    }

    let spec = shortcut.into_string();
    match event.state() {
        ShortcutState::Pressed => {
            let outcome = native_audio::notify_ptt_down(app);
            let _ = app.emit(
                "hotkey:down",
                HotkeyDownPayload {
                    spec: &spec,
                    session_id: outcome.session_id,
                    native_started: outcome.started.then_some(true),
                },
            );
        }
        ShortcutState::Released => {
            let outcome = native_audio::notify_ptt_up(app);
            let _ = app.emit(
                "hotkey:up",
                HotkeyUpPayload {
                    spec: &spec,
                    session_id: outcome.session_id,
                    native_stopped: outcome.stopped.then_some(true),
                },
            );
        }
    }
}

/// Register `spec` as the active global shortcut.
///
/// `spec` may be a modifier + key combo (e.g. `"CommandOrControl+Space"`)
/// *or* a single key with no modifier (e.g. `"F6"`). Single-key specs —
/// function keys in particular — parse and register the same way on every
/// platform, so no special handling is needed here.
#[tauri::command]
pub fn set_hotkey(
    app: AppHandle,
    state: State<'_, HotkeyState>,
    fn_state: State<'_, super::fn_hotkey::FnHotkeyState>,
    spec: String,
) -> Result<(), String> {
    let manager = app.global_shortcut();

    // Sentinel: the macOS fn key and bare Right ⌘ can't be plugin
    // shortcuts — they're hardware modifiers handled by a flags-changed
    // event tap (commands/fn_hotkey.rs).
    if let Some(trigger) = super::fn_hotkey::trigger_for_spec(&spec) {
        super::fn_hotkey::start(app.clone(), &fn_state, trigger)?;
        // The tap owns the hotkey now; release any plugin registration.
        let mut current = state.current.lock().map_err(|e| e.to_string())?;
        if let Some(prev) = current.take() {
            let _ = manager.unregister(prev);
        }
        return Ok(());
    }
    // Switching from a modifier trigger back to a normal shortcut tears
    // the tap down.
    super::fn_hotkey::stop(&fn_state);

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
pub fn clear_hotkey(
    app: AppHandle,
    state: State<'_, HotkeyState>,
    fn_state: State<'_, super::fn_hotkey::FnHotkeyState>,
) -> Result<(), String> {
    super::fn_hotkey::stop(&fn_state);
    let manager = app.global_shortcut();
    let mut current = state.current.lock().map_err(|e| e.to_string())?;
    if let Some(prev) = current.take() {
        manager.unregister(prev).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Register the default Ctrl+Space shortcut at startup. Idempotent.
pub fn install_default(app: &AppHandle) {
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
