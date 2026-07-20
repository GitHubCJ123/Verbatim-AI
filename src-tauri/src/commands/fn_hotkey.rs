//! macOS hardware-modifier hotkeys — the `fn` key and bare Right ⌘
//! (docs/improvement-plan/03-single-key-hotkey.md,
//! docs/proposals/handy-adoption.md §Hotkey handling).
//!
//! `fn` and a lone Right Command are hardware modifiers that never reach
//! `tauri-plugin-global-shortcut` — they only surface as flags-changed
//! events. This module runs a listen-only CGEventTap on a dedicated
//! thread and translates the chosen modifier into the same
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
/// Spec string reserved for a bare Right ⌘. Never a valid plugin shortcut.
pub const RIGHT_COMMAND_SPEC: &str = "RightCommand";

/// Which hardware modifier the event tap is watching.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Trigger {
    Fn,
    RightCommand,
}

impl Trigger {
    /// The sentinel spec this trigger emits its events under.
    #[cfg(target_os = "macos")]
    fn spec(self) -> &'static str {
        match self {
            Trigger::Fn => FN_SPEC,
            Trigger::RightCommand => RIGHT_COMMAND_SPEC,
        }
    }
}

/// Map a hotkey spec to the hardware-modifier trigger it names, if any.
/// Regular plugin shortcuts return `None`.
pub fn trigger_for_spec(spec: &str) -> Option<Trigger> {
    match spec {
        FN_SPEC => Some(Trigger::Fn),
        RIGHT_COMMAND_SPEC => Some(Trigger::RightCommand),
        _ => None,
    }
}

#[derive(Default)]
pub struct FnHotkeyState {
    #[cfg(target_os = "macos")]
    active: Mutex<Option<macos::Active>>,
    #[cfg(not(target_os = "macos"))]
    _unused: Mutex<()>,
}

/// State for the settings **hotkey-capture** tap. This is a listen-only
/// CGEventTap that watches only the `fn` (SecondaryFn) flag and emits
/// dedicated `hotkey-capture:fn-down` / `hotkey-capture:fn-up` events so
/// the settings recorder can bind `fn` WITHOUT triggering real dictation.
/// Deliberately separate from [`FnHotkeyState`] so the two taps stay
/// independent and each idempotent.
#[derive(Default)]
pub struct HotkeyCaptureState {
    #[cfg(target_os = "macos")]
    active: Mutex<Option<macos::SendRunLoop>>,
    #[cfg(not(target_os = "macos"))]
    _unused: Mutex<()>,
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{FnHotkeyState, HotkeyCaptureState, Trigger};
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType, CallbackResult, EventField,
    };
    use serde::Serialize;
    use std::cell::{Cell, RefCell};
    use std::rc::{Rc, Weak};
    use std::sync::mpsc;
    use tauri::{AppHandle, Emitter, Runtime};

    /// Virtual keycode of the Right ⌘ key (`kVK_RightCommand`).
    const RIGHT_COMMAND_KEYCODE: i64 = 54;
    /// Device-dependent modifier bit set while Right ⌘ specifically is
    /// held (`NX_DEVICERCMDKEYMASK`). Unlike `CGEventFlagCommand` it
    /// distinguishes the right key from the left.
    const NX_DEVICE_RIGHT_COMMAND_MASK: u64 = 0x0000_0010;

    // CFRunLoop is not Send, but stopping a run loop from another thread
    // is explicitly supported by CoreFoundation (CFRunLoopStop is
    // thread-safe), so this wrapper is sound for that single use.
    pub struct SendRunLoop(CFRunLoop);
    unsafe impl Send for SendRunLoop {}

    /// The live tap: its run loop (for teardown) plus which trigger it
    /// watches (so `start` is idempotent per-trigger).
    pub struct Active {
        runloop: SendRunLoop,
        pub trigger: Trigger,
    }

    #[derive(Serialize, Clone)]
    struct HotkeyPayload<'a> {
        spec: &'a str,
    }

    extern "C" {
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
    }

    pub fn start<R: Runtime>(
        app: AppHandle<R>,
        state: &FnHotkeyState,
        trigger: Trigger,
    ) -> Result<(), String> {
        {
            let mut guard = state.active.lock().map_err(|e| e.to_string())?;
            match guard.as_ref() {
                // Same trigger already listening — nothing to do.
                Some(active) if active.trigger == trigger => return Ok(()),
                // A different trigger is live — tear it down before we
                // start the new one so only one tap runs at a time.
                Some(_) => {
                    if let Some(active) = guard.take() {
                        active.runloop.0.stop();
                    }
                }
                None => {}
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
                 relaunch the app and pick the modifier hotkey again."
                    .to_string(),
            );
        }

        let (tx, rx) = mpsc::channel::<Result<SendRunLoop, String>>();
        let spec = trigger.spec();

        std::thread::Builder::new()
            .name("modifier-hotkey-tap".into())
            .spawn(move || {
                let is_down = Cell::new(false);
                // Hold the tap so the callback can re-enable it after macOS
                // disables it (kCGEventTapDisabledBy*). The callback keeps a
                // Weak reference to avoid an Rc cycle, so the tap is still
                // dropped when `stop` stops the run loop.
                let tap_holder: Rc<RefCell<Option<CGEventTap<'static>>>> =
                    Rc::new(RefCell::new(None));
                let tap_weak: Weak<RefCell<Option<CGEventTap<'static>>>> =
                    Rc::downgrade(&tap_holder);
                // SAFETY: the tap is installed only on THIS thread's run loop
                // and is dropped when this thread unwinds (after `stop`), so
                // its non-Send callback state never crosses threads or outlives
                // the tap. Mirrors `CGEventTap::with_enabled`, but keeps the
                // tap reachable so the callback can re-enable it on disable.
                let created = unsafe {
                    CGEventTap::new_unchecked(
                    CGEventTapLocation::Session,
                    CGEventTapPlacement::HeadInsertEventTap,
                    CGEventTapOptions::ListenOnly,
                    vec![CGEventType::FlagsChanged],
                    move |_proxy, etype, event| {
                        // macOS disables a slow tap, or during heavy input; if
                        // we don't re-enable it the fn / Right ⌘ hotkey stops
                        // working silently mid-session.
                        if matches!(
                            etype,
                            CGEventType::TapDisabledByTimeout
                                | CGEventType::TapDisabledByUserInput
                        ) {
                            if let Some(holder) = tap_weak.upgrade() {
                                if let Some(tap) = holder.borrow().as_ref() {
                                    tap.enable();
                                }
                            }
                            // A lost release edge would leave recording stuck
                            // on — synthesize an up if we were mid-hold.
                            if is_down.get() {
                                is_down.set(false);
                                let _ = app.emit("hotkey:up", HotkeyPayload { spec });
                            }
                            return CallbackResult::Keep;
                        }
                        let now = match trigger {
                            Trigger::Fn => event
                                .get_flags()
                                .contains(CGEventFlags::CGEventFlagSecondaryFn),
                            Trigger::RightCommand => {
                                // Only Right ⌘ transitions matter; ignore
                                // every other modifier's flags-changed.
                                let keycode = event
                                    .get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                                if keycode != RIGHT_COMMAND_KEYCODE {
                                    return CallbackResult::Keep;
                                }
                                // Use the device-specific right-⌘ bit
                                // (NX_DEVICERCMDKEYMASK) rather than the
                                // aggregate Command flag: the aggregate
                                // bit can't tell left from right, so a
                                // Right ⌘ release while Left ⌘ is held
                                // would otherwise be missed and leave the
                                // trigger stuck down. The device bit
                                // reflects Right ⌘ alone, so press and
                                // release are always seen.
                                (event.get_flags().bits() & NX_DEVICE_RIGHT_COMMAND_MASK) != 0
                            }
                        };
                        if now != is_down.get() {
                            is_down.set(now);
                            let name = if now { "hotkey:down" } else { "hotkey:up" };
                            let _ = app.emit(name, HotkeyPayload { spec });
                        }
                        CallbackResult::Keep
                    },
                    )
                };

                match created {
                    Ok(tap) => match tap.mach_port().create_runloop_source(0) {
                        Ok(loop_source) => {
                            // Attach + enable exactly like `with_enabled`, but
                            // keep the tap in `tap_holder` so the callback can
                            // re-enable it on a disabled-tap event.
                            CFRunLoop::get_current()
                                .add_source(&loop_source, unsafe { kCFRunLoopCommonModes });
                            tap.enable();
                            *tap_holder.borrow_mut() = Some(tap);
                            let _ = tx.send(Ok(SendRunLoop(CFRunLoop::get_current())));
                            CFRunLoop::run_current();
                            // Run loop stopped by `stop`: drop the tap, which
                            // invalidates the mach port.
                            drop(tap_holder);
                        }
                        Err(()) => {
                            let _ = tx.send(Err(
                                "Couldn't attach the modifier-key event tap to the run loop."
                                    .into(),
                            ));
                        }
                    },
                    Err(()) => {
                        let _ = tx.send(Err(
                            "Couldn't create the modifier-key event tap. If you just \
                             granted Input Monitoring, relaunch the app and try again."
                                .into(),
                        ));
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        let runloop = rx
            .recv()
            .map_err(|_| "modifier-key listener thread died during startup".to_string())??;
        let mut guard = state.active.lock().map_err(|e| e.to_string())?;
        *guard = Some(Active { runloop, trigger });
        Ok(())
    }

    pub fn stop(state: &FnHotkeyState) {
        if let Ok(mut guard) = state.active.lock() {
            if let Some(active) = guard.take() {
                active.runloop.0.stop();
            }
        }
    }

    /// Silently preflight Input Monitoring and, if granted, start a
    /// listen-only capture tap that watches ONLY the `fn` (SecondaryFn)
    /// flag and emits `hotkey-capture:fn-down` / `hotkey-capture:fn-up`.
    /// Idempotent: a no-op returning `Ok(())` if a capture tap is live.
    ///
    /// Unlike [`start`], this NEVER calls `CGRequestListenEventAccess` —
    /// the recorder shows its own guidance and the explicit
    /// `request_input_monitoring` command owns the TCC prompt.
    pub fn start_capture<R: Runtime>(
        app: AppHandle<R>,
        state: &HotkeyCaptureState,
    ) -> Result<(), String> {
        {
            // Already capturing — idempotent no-op, don't start a second tap.
            let guard = state.active.lock().map_err(|e| e.to_string())?;
            if guard.is_some() {
                return Ok(());
            }
        }

        // Silent preflight ONLY — never auto-prompt here (deliberate).
        if unsafe { !CGPreflightListenEventAccess() } {
            return Err("needs-input-monitoring".to_string());
        }

        let (tx, rx) = mpsc::channel::<Result<SendRunLoop, String>>();

        std::thread::Builder::new()
            .name("hotkey-capture-tap".into())
            .spawn(move || {
                let is_down = Cell::new(false);
                // Hold the tap so the callback can re-enable it after macOS
                // disables it (kCGEventTapDisabledBy*). The callback keeps a
                // Weak reference to avoid an Rc cycle, so the tap is still
                // dropped when `stop_capture` stops the run loop.
                let tap_holder: Rc<RefCell<Option<CGEventTap<'static>>>> =
                    Rc::new(RefCell::new(None));
                let tap_weak: Weak<RefCell<Option<CGEventTap<'static>>>> =
                    Rc::downgrade(&tap_holder);
                // SAFETY: the tap is installed only on THIS thread's run loop
                // and is dropped when this thread unwinds (after
                // `stop_capture`), so its non-Send callback state never crosses
                // threads or outlives the tap. Mirrors `CGEventTap::with_enabled`,
                // but keeps the tap reachable so the callback can re-enable it.
                let created = unsafe {
                    CGEventTap::new_unchecked(
                        CGEventTapLocation::Session,
                        CGEventTapPlacement::HeadInsertEventTap,
                        CGEventTapOptions::ListenOnly,
                        vec![CGEventType::FlagsChanged],
                        move |_proxy, etype, event| {
                            if matches!(
                                etype,
                                CGEventType::TapDisabledByTimeout
                                    | CGEventType::TapDisabledByUserInput
                            ) {
                                if let Some(holder) = tap_weak.upgrade() {
                                    if let Some(tap) = holder.borrow().as_ref() {
                                        tap.enable();
                                    }
                                }
                                // A lost release edge would strand the
                                // recorder's pending capture — synthesize an
                                // up if `fn` was mid-hold.
                                if is_down.get() {
                                    is_down.set(false);
                                    let _ = app.emit("hotkey-capture:fn-up", ());
                                }
                                return CallbackResult::Keep;
                            }
                            // Watch ONLY the `fn` (SecondaryFn) flag.
                            let now = event
                                .get_flags()
                                .contains(CGEventFlags::CGEventFlagSecondaryFn);
                            if now != is_down.get() {
                                is_down.set(now);
                                let name = if now {
                                    "hotkey-capture:fn-down"
                                } else {
                                    "hotkey-capture:fn-up"
                                };
                                let _ = app.emit(name, ());
                            }
                            CallbackResult::Keep
                        },
                    )
                };

                match created {
                    Ok(tap) => match tap.mach_port().create_runloop_source(0) {
                        Ok(loop_source) => {
                            CFRunLoop::get_current()
                                .add_source(&loop_source, unsafe { kCFRunLoopCommonModes });
                            tap.enable();
                            *tap_holder.borrow_mut() = Some(tap);
                            let _ = tx.send(Ok(SendRunLoop(CFRunLoop::get_current())));
                            CFRunLoop::run_current();
                            // Run loop stopped by `stop_capture`: drop the tap,
                            // which invalidates the mach port.
                            drop(tap_holder);
                        }
                        Err(()) => {
                            let _ = tx.send(Err(
                                "Couldn't attach the hotkey-capture event tap to the run loop."
                                    .into(),
                            ));
                        }
                    },
                    Err(()) => {
                        let _ = tx.send(Err(
                            "Couldn't create the hotkey-capture event tap. If you just \
                             granted Input Monitoring, relaunch the app and try again."
                                .into(),
                        ));
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        let runloop = rx
            .recv()
            .map_err(|_| "hotkey-capture listener thread died during startup".to_string())??;
        let mut guard = state.active.lock().map_err(|e| e.to_string())?;
        // Defensive: if a concurrent start_capture raced past the initial
        // idempotency check and already installed a tap, stop the previous
        // run loop instead of leaking its thread + tap.
        if let Some(old) = guard.replace(runloop) {
            old.0.stop();
        }
        Ok(())
    }

    /// Tear down the capture tap if running. Tolerant/idempotent — a
    /// harmless no-op when nothing is live.
    pub fn stop_capture(state: &HotkeyCaptureState) {
        if let Ok(mut guard) = state.active.lock() {
            if let Some(runloop) = guard.take() {
                runloop.0.stop();
            }
        }
    }

    /// Explicit TCC path: show the Input Monitoring prompt (first time)
    /// and add the app to the System Settings list.
    pub fn request_input_monitoring() {
        unsafe {
            CGRequestListenEventAccess();
        }
    }
}

#[cfg(target_os = "macos")]
pub fn start<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: &FnHotkeyState,
    trigger: Trigger,
) -> Result<(), String> {
    macos::start(app, state, trigger)
}

#[cfg(not(target_os = "macos"))]
pub fn start<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    _state: &FnHotkeyState,
    _trigger: Trigger,
) -> Result<(), String> {
    Err("Modifier-only hotkeys (fn / Right ⌘) are only supported on macOS.".into())
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

/// Start the settings hotkey-capture tap (macOS). Silently preflights
/// Input Monitoring and returns `Err("needs-input-monitoring")` when not
/// granted (no auto-prompt). Idempotent; no-op on non-macOS.
#[tauri::command]
pub fn start_hotkey_capture<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, HotkeyCaptureState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::start_capture(app, state.inner())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state);
        Ok(())
    }
}

/// Stop/tear down the settings hotkey-capture tap. Tolerant/idempotent —
/// safe to call after a failed start, after commit, after cancel, or
/// during unmount. No-op on non-macOS.
#[tauri::command]
pub fn stop_hotkey_capture(state: tauri::State<'_, HotkeyCaptureState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::stop_capture(state.inner());
    }
    #[cfg(not(target_os = "macos"))]
    let _ = state;
    Ok(())
}

/// Explicitly request the Input Monitoring permission — shows the TCC
/// prompt the first time and adds the app to the System Settings list.
/// No-op on non-macOS.
#[tauri::command]
pub fn request_input_monitoring() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    macos::request_input_monitoring();
    Ok(())
}
