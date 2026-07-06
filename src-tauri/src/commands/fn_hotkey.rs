//! macOS `fn`-key hotkey (docs/improvement-plan/03-single-key-hotkey.md).
//!
//! The `fn` key is a hardware modifier that never reaches
//! `tauri-plugin-global-shortcut` — it only surfaces as a flags-changed
//! event. This module runs a listen-only CGEventTap on a dedicated
//! thread and translates the `SecondaryFn` bit into the same
//! `hotkey:down` / `hotkey:up` events the rest of the app already
//! consumes, so nothing downstream changes.
//!
//! Requires the Input Monitoring permission (TCC). `start` preflights
//! it and returns the sentinel error `needs-input-monitoring` so the
//! frontend can guide the user; `CGRequestListenEventAccess` both
//! prompts and adds the app to the System Settings list.

use std::sync::Mutex;

/// Spec string reserved for the fn key. Never a valid plugin shortcut.
pub const FN_SPEC: &str = "Fn";

#[derive(Default)]
pub struct FnHotkeyState {
    #[cfg(target_os = "macos")]
    runloop: Mutex<Option<macos::SendRunLoop>>,
    #[cfg(not(target_os = "macos"))]
    _unused: Mutex<()>,
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{FnHotkeyState, FN_SPEC};
    use core_foundation::runloop::CFRunLoop;
    use core_graphics::event::{
        CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType, CallbackResult,
    };
    use serde::Serialize;
    use std::cell::Cell;
    use std::sync::mpsc;
    use tauri::{AppHandle, Emitter, Runtime};

    // CFRunLoop is not Send, but stopping a run loop from another thread
    // is explicitly supported by CoreFoundation (CFRunLoopStop is
    // thread-safe), so this wrapper is sound for that single use.
    pub struct SendRunLoop(CFRunLoop);
    unsafe impl Send for SendRunLoop {}

    #[derive(Serialize, Clone)]
    struct HotkeyPayload<'a> {
        spec: &'a str,
    }

    extern "C" {
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
    }

    pub fn start<R: Runtime>(app: AppHandle<R>, state: &FnHotkeyState) -> Result<(), String> {
        {
            let guard = state.runloop.lock().map_err(|e| e.to_string())?;
            if guard.is_some() {
                return Ok(()); // already listening
            }
        }

        // Input Monitoring permission. The request call shows the TCC
        // prompt (first time) and adds the app to the System Settings
        // list; macOS typically requires an app relaunch after granting.
        if unsafe { !CGPreflightListenEventAccess() } {
            unsafe {
                CGRequestListenEventAccess();
            }
            return Err(
                "needs-input-monitoring: grant Input Monitoring to Verbatim AI in \
                 System Settings → Privacy & Security → Input Monitoring, then \
                 relaunch the app and pick the fn key again."
                    .to_string(),
            );
        }

        let (tx, rx) = mpsc::channel::<Result<SendRunLoop, String>>();

        std::thread::Builder::new()
            .name("fn-hotkey-tap".into())
            .spawn(move || {
                let fn_down = Cell::new(false);
                // `with_enabled` creates the tap, attaches it to this
                // thread's run loop, enables it, and destroys it when the
                // run-loop call below returns (i.e. when `stop` fires).
                let created = CGEventTap::with_enabled(
                    CGEventTapLocation::Session,
                    CGEventTapPlacement::HeadInsertEventTap,
                    CGEventTapOptions::ListenOnly,
                    vec![CGEventType::FlagsChanged],
                    |_proxy, _etype, event| {
                        let now = event
                            .get_flags()
                            .contains(CGEventFlags::CGEventFlagSecondaryFn);
                        if now != fn_down.get() {
                            fn_down.set(now);
                            let name = if now { "hotkey:down" } else { "hotkey:up" };
                            let _ = app.emit(name, HotkeyPayload { spec: FN_SPEC });
                        }
                        CallbackResult::Keep
                    },
                    || {
                        let _ = tx.send(Ok(SendRunLoop(CFRunLoop::get_current())));
                        CFRunLoop::run_current();
                    },
                );
                if created.is_err() {
                    let _ = tx.send(Err(
                        "Couldn't create the fn-key event tap. If you just granted \
                         Input Monitoring, relaunch the app and try again."
                            .into(),
                    ));
                }
            })
            .map_err(|e| e.to_string())?;

        let runloop = rx
            .recv()
            .map_err(|_| "fn-key listener thread died during startup".to_string())??;
        let mut guard = state.runloop.lock().map_err(|e| e.to_string())?;
        *guard = Some(runloop);
        Ok(())
    }

    pub fn stop(state: &FnHotkeyState) {
        if let Ok(mut guard) = state.runloop.lock() {
            if let Some(SendRunLoop(runloop)) = guard.take() {
                runloop.stop();
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn start<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: &FnHotkeyState,
) -> Result<(), String> {
    macos::start(app, state)
}

#[cfg(not(target_os = "macos"))]
pub fn start<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    _state: &FnHotkeyState,
) -> Result<(), String> {
    Err("The fn key is only supported on macOS.".into())
}

pub fn stop(state: &FnHotkeyState) {
    #[cfg(target_os = "macos")]
    macos::stop(state);
    #[cfg(not(target_os = "macos"))]
    let _ = state;
}

/// Open the Input Monitoring pane of System Settings so the user can
/// grant access without hunting for it.
#[tauri::command]
pub fn open_input_monitoring_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    Err("macOS only.".into())
}
