//! Paste output to the previously focused window (plan §14).
//!
//! Flow:
//!   1. Frontend calls `capture_target_window()` *before* showing the
//!      overlay so we remember which app had focus.
//!   2. Clipboard modes write the cleaned text to the clipboard, then
//!      call `paste_to_target()` which:
//!      - Restores foreground to the captured HWND
//!      - Briefly waits so Windows finishes the focus change
//!      - Sends the selected paste shortcut via `enigo`
//!   3. Direct mode restores focus and types text directly without
//!      touching the clipboard.
//!
//! If no target was captured, `paste_to_target()` returns Ok(false) so
//! the caller can choose the right clipboard or review fallback.

use std::sync::Mutex;

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Default)]
pub struct TargetWindowState(pub Mutex<Option<isize>>);

#[derive(Debug, Clone, Serialize)]
pub struct CapturedTarget {
    /// Foreground window handle, stringified so we can round-trip
    /// through serde without losing precision on 64-bit Windows.
    pub hwnd: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PasteMethod {
    Auto,
    CtrlV,
    ShiftInsert,
    Direct,
}

impl Default for PasteMethod {
    fn default() -> Self {
        Self::Auto
    }
}

fn effective_paste_method(method: PasteMethod) -> PasteMethod {
    match method {
        PasteMethod::Auto => {
            #[cfg(target_os = "linux")]
            {
                PasteMethod::Direct
            }
            #[cfg(not(target_os = "linux"))]
            {
                PasteMethod::CtrlV
            }
        }
        other => other,
    }
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

    pub fn current_foreground() -> Option<isize> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() { None } else { Some(hwnd.0 as isize) }
        }
    }

    pub fn restore_foreground(hwnd_raw: isize) -> bool {
        unsafe {
            let hwnd = HWND(hwnd_raw as *mut _);
            SetForegroundWindow(hwnd).as_bool()
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::{class, msg_send, msg_send_id};
    use objc2_app_kit::{NSRunningApplication, NSWorkspace};

    /// Returns the PID of the frontmost app (stored as isize so we can
    /// share the same TargetWindowState slot with Windows).
    pub fn current_foreground() -> Option<isize> {
        unsafe {
            let workspace = NSWorkspace::sharedWorkspace();
            let app = workspace.frontmostApplication()?;
            let pid: i32 = msg_send![&*app, processIdentifier];
            Some(pid as isize)
        }
    }

    pub fn restore_foreground(pid_raw: isize) -> bool {
        unsafe {
            let cls = class!(NSRunningApplication);
            let pid: i32 = pid_raw as i32;
            let app: Option<Retained<NSRunningApplication>> =
                msg_send_id![cls, runningApplicationWithProcessIdentifier: pid];
            let Some(app) = app else { return false };
            // NSApplicationActivateAllWindows = 1 << 0
            let opts: u64 = 1;
            let ok: bool = msg_send![&*app, activateWithOptions: opts];
            ok
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    pub fn current_foreground() -> Option<isize> { None }
    pub fn restore_foreground(_: isize) -> bool { false }
}

#[tauri::command]
pub fn capture_target_window(state: State<'_, TargetWindowState>) -> Option<CapturedTarget> {
    let hwnd = imp::current_foreground()?;
    *state.0.lock().ok()? = Some(hwnd);
    Some(CapturedTarget { hwnd: hwnd.to_string() })
}

#[tauri::command]
pub fn clear_target_window(state: State<'_, TargetWindowState>) {
    if let Ok(mut g) = state.0.lock() {
        *g = None;
    }
}

fn captured_target(state: &State<'_, TargetWindowState>) -> Result<Option<isize>, String> {
    let g = state.0.lock().map_err(|e| e.to_string())?;
    Ok(*g)
}

fn send_ctrl_v(enigo: &mut Enigo) -> Result<(), String> {
    // ⌘ on macOS, Ctrl elsewhere.
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;
    enigo.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
fn send_shift_insert(enigo: &mut Enigo) -> Result<(), String> {
    enigo
        .key(Key::Shift, Direction::Press)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Insert, Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Shift, Direction::Release)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn send_shift_insert(_: &mut Enigo) -> Result<(), String> {
    Err("Shift+Insert paste is not supported on macOS.".into())
}

/// Restore focus to the captured target window and paste text using the
/// selected method. Clipboard-based methods expect the caller to have already
/// written `text` to the system clipboard.
/// Returns Ok(true) if pasted, Ok(false) if no target was captured.
#[tauri::command]
pub fn paste_to_target(
    state: State<'_, TargetWindowState>,
    text: Option<String>,
    method: Option<PasteMethod>,
) -> Result<bool, String> {
    let hwnd = captured_target(&state)?;
    let Some(hwnd) = hwnd else {
        return Ok(false);
    };
    let method = effective_paste_method(method.unwrap_or_default());

    // Best-effort focus restore. SetForegroundWindow can be denied by
    // Windows when the calling process isn't the active one. We accept
    // that and try the keystroke anyway — if focus didn't move we'll
    // just paste into our own window (clipboard still has the value).
    let focus_restored = imp::restore_foreground(hwnd);

    // Small wait so the focus change actually propagates before we
    // send synthetic input.
    std::thread::sleep(std::time::Duration::from_millis(60));

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    match method {
        PasteMethod::CtrlV => send_ctrl_v(&mut enigo)?,
        PasteMethod::ShiftInsert => send_shift_insert(&mut enigo)?,
        PasteMethod::Direct => {
            if !focus_restored {
                return Ok(false);
            }
            let Some(text) = text else {
                return Err("Direct paste requires text.".into());
            };
            enigo.text(&text).map_err(|e| e.to_string())?;
        }
        PasteMethod::Auto => unreachable!("auto paste method must be resolved before execution"),
    }

    Ok(true)
}

/// Restore focus to the captured target window and type text directly,
/// avoiding the system clipboard and clipboard history.
#[tauri::command]
pub fn insert_text_to_target(
    state: State<'_, TargetWindowState>,
    text: String,
) -> Result<bool, String> {
    let hwnd = captured_target(&state)?;
    let Some(hwnd) = hwnd else {
        return Ok(false);
    };

    if !imp::restore_foreground(hwnd) {
        return Ok(false);
    }
    std::thread::sleep(std::time::Duration::from_millis(60));

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.text(&text).map_err(|e| e.to_string())?;

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{effective_paste_method, PasteMethod};

    #[test]
    #[cfg(target_os = "linux")]
    fn auto_defaults_to_direct_on_linux() {
        assert_eq!(effective_paste_method(PasteMethod::Auto), PasteMethod::Direct);
    }

    #[test]
    #[cfg(not(target_os = "linux"))]
    fn auto_defaults_to_ctrl_v_off_linux() {
        assert_eq!(effective_paste_method(PasteMethod::Auto), PasteMethod::CtrlV);
    }

    #[test]
    fn explicit_methods_are_preserved() {
        assert_eq!(effective_paste_method(PasteMethod::CtrlV), PasteMethod::CtrlV);
        assert_eq!(
            effective_paste_method(PasteMethod::ShiftInsert),
            PasteMethod::ShiftInsert
        );
        assert_eq!(
            effective_paste_method(PasteMethod::Direct),
            PasteMethod::Direct
        );
    }
}
