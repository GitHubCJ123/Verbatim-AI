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
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

#[derive(Default)]
pub struct HotkeyState {
    current: Mutex<Option<Binding>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Binding {
    Shortcut(Shortcut),
    Modifier(super::fn_hotkey::Trigger),
}

trait Registration {
    fn activate(&self, binding: &Binding) -> Result<(), String>;
    fn deactivate(&self, binding: &Binding) -> Result<(), String>;
    fn owns(&self, binding: &Binding) -> bool;
}

/// Acquire the replacement before releasing the working binding. Modifier
/// taps share one slot, so a failed modifier-to-modifier start needs rollback.
fn replace_binding(
    current: &mut Option<Binding>,
    next: Binding,
    registration: &impl Registration,
) -> Result<(), String> {
    if current.as_ref() == Some(&next)
        && matches!(next, Binding::Shortcut(_))
        && registration.owns(&next)
    {
        return Ok(());
    }
    if matches!(next, Binding::Shortcut(_)) && registration.owns(&next) {
        return Err("hotkey-in-use: That shortcut is already registered by Verbatim AI for another action. Choose another shortcut.".into());
    }
    if let Err(error) = registration.activate(&next) {
        if matches!(next, Binding::Modifier(_)) {
            if let Some(previous @ Binding::Modifier(_)) = current.as_ref() {
                if let Err(restore) = registration.activate(previous) {
                    *current = None;
                    return Err(format!(
                        "{error}. Previous shortcut could not be restored: {restore}"
                    ));
                }
            }
        }
        return Err(error);
    }

    if let Some(previous) = current.as_ref() {
        // Starting a modifier replaces the old modifier tap itself.
        if previous != &next
            && !matches!(
                (previous, &next),
                (Binding::Modifier(_), Binding::Modifier(_))
            )
        {
            if let Err(error) = registration.deactivate(previous) {
                let rollback = registration.deactivate(&next);
                return Err(match rollback {
                    Ok(()) => format!("Couldn't release previous shortcut: {error}"),
                    Err(restore) => format!(
                        "Couldn't release previous shortcut: {error}. Couldn't remove replacement: {restore}"
                    ),
                });
            }
        }
    }
    *current = Some(next);
    Ok(())
}

fn registration_error(message: &str, windows: bool) -> String {
    // The plugin erases global-hotkey's typed errors into strings. On Windows,
    // this exact prefix comes from ERROR_HOTKEY_ALREADY_REGISTERED (1409).
    if windows && message.starts_with("HotKey already registered:") {
        format!("hotkey-in-use: That shortcut is already in use. Choose another shortcut; Verbatim AI cannot override another app's shortcut. ({message})")
    } else {
        format!("Failed to register shortcut: {message}")
    }
}

struct NativeRegistration<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    fn_state: &'a super::fn_hotkey::FnHotkeyState,
}

impl<R: Runtime> Registration for NativeRegistration<'_, R> {
    fn activate(&self, binding: &Binding) -> Result<(), String> {
        match binding {
            Binding::Modifier(trigger) => {
                super::fn_hotkey::start(self.app.clone(), self.fn_state, *trigger)
            }
            Binding::Shortcut(shortcut) => {
                self.app
                    .global_shortcut()
                    .register(*shortcut)
                    .map_err(|error| {
                        registration_error(&error.to_string(), cfg!(target_os = "windows"))
                    })
            }
        }
    }

    fn deactivate(&self, binding: &Binding) -> Result<(), String> {
        match binding {
            Binding::Modifier(_) => {
                super::fn_hotkey::stop(self.fn_state);
                Ok(())
            }
            Binding::Shortcut(shortcut) => self
                .app
                .global_shortcut()
                .unregister(*shortcut)
                .map_err(|error| error.to_string()),
        }
    }

    fn owns(&self, binding: &Binding) -> bool {
        match binding {
            Binding::Shortcut(shortcut) => self.app.global_shortcut().is_registered(*shortcut),
            Binding::Modifier(_) => false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct HotkeyPayload<'a> {
    spec: &'a str,
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, event: ShortcutEvent) {
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
#[tauri::command]
pub fn set_hotkey<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, HotkeyState>,
    fn_state: State<'_, super::fn_hotkey::FnHotkeyState>,
    spec: String,
) -> Result<(), String> {
    let next = if let Some(trigger) = super::fn_hotkey::trigger_for_spec(&spec) {
        Binding::Modifier(trigger)
    } else {
        Binding::Shortcut(Shortcut::from_str(&spec).map_err(|e| format!("Invalid shortcut: {e}"))?)
    };
    let mut current = state.current.lock().map_err(|e| e.to_string())?;
    replace_binding(
        &mut current,
        next,
        &NativeRegistration {
            app: &app,
            fn_state: &fn_state,
        },
    )
}

#[tauri::command]
pub fn get_hotkey(state: State<'_, HotkeyState>) -> Result<Option<String>, String> {
    let current = state.current.lock().map_err(|e| e.to_string())?;
    Ok(current.as_ref().map(|binding| match binding {
        Binding::Shortcut(shortcut) => shortcut.into_string(),
        Binding::Modifier(super::fn_hotkey::Trigger::Fn) => "Fn".into(),
        Binding::Modifier(super::fn_hotkey::Trigger::RightCommand) => "RightCommand".into(),
    }))
}

#[tauri::command]
pub fn clear_hotkey<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, HotkeyState>,
    fn_state: State<'_, super::fn_hotkey::FnHotkeyState>,
) -> Result<(), String> {
    let mut current = state.current.lock().map_err(|e| e.to_string())?;
    if let Some(previous) = current.as_ref() {
        NativeRegistration {
            app: &app,
            fn_state: &fn_state,
        }
        .deactivate(previous)?;
    }
    *current = None;
    Ok(())
}

/// Register a platform-safe default at startup.
pub fn install_default<R: Runtime>(app: &AppHandle<R>) {
    let spec = if cfg!(target_os = "macos") {
        "Control+Shift+Space"
    } else {
        "CommandOrControl+Space"
    };
    if let Err(error) = set_hotkey(app.clone(), app.state(), app.state(), spec.into()) {
        eprintln!("[Verbatim AI] Default hotkey is not active: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeRegistration {
        active: RefCell<Vec<Binding>>,
        failures: Vec<Binding>,
        activation_error: Option<String>,
        release_failure: Option<Binding>,
        calls: RefCell<Vec<String>>,
    }

    impl Registration for FakeRegistration {
        fn activate(&self, binding: &Binding) -> Result<(), String> {
            self.calls
                .borrow_mut()
                .push(format!("activate {binding:?}"));
            let mut active = self.active.borrow_mut();
            // Model the existing shared Fn/right-command slot, including its
            // destructive failed-start behavior, without using an OS event tap.
            if matches!(binding, Binding::Modifier(_)) {
                active.retain(|entry| !matches!(entry, Binding::Modifier(_)));
            }
            if self.failures.contains(binding) {
                return Err(self
                    .activation_error
                    .clone()
                    .unwrap_or_else(|| "registration failed".into()));
            }
            if active.contains(binding) {
                return Err("HotKey already registered: synthetic".into());
            }
            active.push(binding.clone());
            Ok(())
        }

        fn deactivate(&self, binding: &Binding) -> Result<(), String> {
            self.calls
                .borrow_mut()
                .push(format!("deactivate {binding:?}"));
            if self.release_failure.as_ref() == Some(binding) {
                return Err("release failed".into());
            }
            self.active.borrow_mut().retain(|entry| entry != binding);
            Ok(())
        }

        fn owns(&self, binding: &Binding) -> bool {
            self.active.borrow().contains(binding)
        }
    }

    fn shortcut(spec: &str) -> Binding {
        Binding::Shortcut(Shortcut::from_str(spec).unwrap())
    }

    #[test]
    fn failed_replacement_keeps_previous_registration() {
        let previous = shortcut("F6");
        let next = shortcut("F9");
        let registration = FakeRegistration {
            active: RefCell::new(vec![previous.clone()]),
            failures: vec![next.clone()],
            ..Default::default()
        };
        let mut current = Some(previous.clone());
        assert!(replace_binding(&mut current, next, &registration).is_err());
        assert_eq!(current, Some(previous.clone()));
        assert_eq!(*registration.active.borrow(), vec![previous]);
        assert_eq!(registration.calls.borrow().len(), 1);
    }

    #[test]
    fn already_registered_candidate_is_not_success_or_stolen_from_another_entry_point() {
        let previous = shortcut("F6");
        let next = shortcut("F9");
        let registration = FakeRegistration {
            active: RefCell::new(vec![previous.clone(), next.clone()]),
            ..Default::default()
        };
        let mut current = Some(previous.clone());
        assert!(replace_binding(&mut current, next.clone(), &registration)
            .unwrap_err()
            .contains("already registered"));
        assert_eq!(current, Some(previous.clone()));
        assert_eq!(*registration.active.borrow(), vec![previous, next]);
        assert!(registration.calls.borrow().is_empty());
    }

    #[test]
    fn os_already_registered_failure_is_never_treated_as_success() {
        let previous = shortcut("F6");
        let next = shortcut("F9");
        let registration = FakeRegistration {
            active: RefCell::new(vec![previous.clone()]),
            failures: vec![next.clone()],
            activation_error: Some(registration_error(
                "HotKey already registered: synthetic",
                true,
            )),
            ..Default::default()
        };
        let mut current = Some(previous.clone());
        let error = replace_binding(&mut current, next, &registration).unwrap_err();
        assert!(error.starts_with("hotkey-in-use:"));
        assert_eq!(current, Some(previous.clone()));
        assert_eq!(*registration.active.borrow(), vec![previous]);
    }

    #[test]
    fn modifier_permission_failure_keeps_previous_normal_shortcut() {
        let previous = shortcut("F6");
        let next = Binding::Modifier(super::super::fn_hotkey::Trigger::Fn);
        let registration = FakeRegistration {
            active: RefCell::new(vec![previous.clone()]),
            failures: vec![next.clone()],
            activation_error: Some("needs-input-monitoring".into()),
            ..Default::default()
        };
        let mut current = Some(previous.clone());
        assert_eq!(
            replace_binding(&mut current, next, &registration).unwrap_err(),
            "needs-input-monitoring"
        );
        assert_eq!(current, Some(previous.clone()));
        assert_eq!(*registration.active.borrow(), vec![previous]);
    }

    #[test]
    fn owned_current_shortcut_is_idempotent_but_a_missing_registration_is_retried() {
        let next = shortcut("F6");
        let registration = FakeRegistration {
            active: RefCell::new(vec![next.clone()]),
            ..Default::default()
        };
        let mut current = Some(next.clone());
        replace_binding(&mut current, next.clone(), &registration).unwrap();
        assert!(registration.calls.borrow().is_empty());
        registration.active.borrow_mut().clear();
        replace_binding(&mut current, next.clone(), &registration).unwrap();
        assert_eq!(*registration.active.borrow(), vec![next]);
    }

    #[test]
    fn success_acquires_new_shortcut_before_releasing_previous() {
        let previous = shortcut("F6");
        let next = shortcut("F9");
        let registration = FakeRegistration {
            active: RefCell::new(vec![previous.clone()]),
            ..Default::default()
        };
        let mut current = Some(previous);
        replace_binding(&mut current, next.clone(), &registration).unwrap();
        assert_eq!(current, Some(next.clone()));
        assert_eq!(*registration.active.borrow(), vec![next]);
        assert!(registration.calls.borrow()[0].starts_with("activate"));
        assert!(registration.calls.borrow()[1].starts_with("deactivate"));
    }

    #[test]
    fn failed_release_rolls_back_the_candidate() {
        let previous = shortcut("F6");
        let next = shortcut("F9");
        let registration = FakeRegistration {
            active: RefCell::new(vec![previous.clone()]),
            release_failure: Some(previous.clone()),
            ..Default::default()
        };
        let mut current = Some(previous.clone());
        assert!(replace_binding(&mut current, next, &registration).is_err());
        assert_eq!(current, Some(previous.clone()));
        assert_eq!(*registration.active.borrow(), vec![previous]);
    }

    #[test]
    fn failed_normal_shortcut_keeps_modifier_tap() {
        let previous = Binding::Modifier(super::super::fn_hotkey::Trigger::Fn);
        let next = shortcut("F9");
        let registration = FakeRegistration {
            active: RefCell::new(vec![previous.clone()]),
            failures: vec![next.clone()],
            ..Default::default()
        };
        let mut current = Some(previous.clone());
        assert!(replace_binding(&mut current, next, &registration).is_err());
        assert_eq!(*registration.active.borrow(), vec![previous]);
    }

    #[test]
    fn failed_modifier_switch_restores_previous_tap_and_reports_failed_rollback() {
        let previous = Binding::Modifier(super::super::fn_hotkey::Trigger::Fn);
        let next = Binding::Modifier(super::super::fn_hotkey::Trigger::RightCommand);
        let mut registration = FakeRegistration {
            active: RefCell::new(vec![previous.clone()]),
            failures: vec![next.clone()],
            ..Default::default()
        };
        let mut current = Some(previous.clone());
        assert!(replace_binding(&mut current, next.clone(), &registration).is_err());
        assert_eq!(current, Some(previous.clone()));
        assert_eq!(*registration.active.borrow(), vec![previous.clone()]);

        registration.failures.push(previous);
        assert!(replace_binding(&mut current, next, &registration)
            .unwrap_err()
            .contains("could not be restored"));
        assert_eq!(current, None);
        assert!(registration.active.borrow().is_empty());
    }

    #[test]
    fn successful_modifier_switch_does_not_stop_the_new_tap() {
        let previous = Binding::Modifier(super::super::fn_hotkey::Trigger::Fn);
        let next = Binding::Modifier(super::super::fn_hotkey::Trigger::RightCommand);
        let registration = FakeRegistration {
            active: RefCell::new(vec![previous.clone()]),
            ..Default::default()
        };
        let mut current = Some(previous);
        replace_binding(&mut current, next.clone(), &registration).unwrap();
        assert_eq!(*registration.active.borrow(), vec![next]);
        assert_eq!(registration.calls.borrow().len(), 1);
    }

    #[test]
    fn windows_conflict_is_actionable_but_other_errors_are_not_misclassified() {
        let conflict = "HotKey already registered: synthetic";
        assert!(registration_error(conflict, true).starts_with("hotkey-in-use:"));
        assert!(!registration_error(conflict, false).contains("hotkey-in-use"));
        assert!(!registration_error("Access denied", true).contains("hotkey-in-use"));
    }
}
