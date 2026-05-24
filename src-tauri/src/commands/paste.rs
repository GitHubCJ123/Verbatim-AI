//! Paste output to the previously focused window (plan §14).
//!
//! Flow:
//!   1. Frontend calls `capture_target_window()` *before* showing the
//!      overlay so we remember which app had focus.
//!   2. Frontend writes the cleaned text to the clipboard (via the
//!      clipboard-manager plugin from JS).
//!   3. Frontend calls `paste_to_target()` which:
//!      - Restores foreground to the captured HWND
//!      - Briefly waits so Windows finishes the focus change
//!      - Sends Ctrl+V via `enigo`
//!
//! If no target was captured, `paste_to_target()` returns Ok(false) so
//! the caller can fall back to "Copied to clipboard" UX.

use std::sync::Mutex;

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use serde::Serialize;
use tauri::State;

#[derive(Default)]
pub struct TargetWindowState(pub Mutex<Option<isize>>);

#[derive(Debug, Clone, Serialize)]
pub struct CapturedTarget {
    /// Foreground window handle, stringified so we can round-trip
    /// through serde without losing precision on 64-bit Windows.
    pub hwnd: String,
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

#[cfg(not(windows))]
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

/// Restore focus to the captured target window and send Ctrl+V.
/// Returns Ok(true) if pasted, Ok(false) if no target was captured.
#[tauri::command]
pub fn paste_to_target(state: State<'_, TargetWindowState>) -> Result<bool, String> {
    let hwnd = {
        let g = state.0.lock().map_err(|e| e.to_string())?;
        *g
    };

    let Some(hwnd) = hwnd else {
        return Ok(false);
    };

    // Best-effort focus restore. SetForegroundWindow can be denied by
    // Windows when the calling process isn't the active one. We accept
    // that and try the keystroke anyway — if focus didn't move we'll
    // just paste into our own window (clipboard still has the value).
    imp::restore_foreground(hwnd);

    // Small wait so the focus change actually propagates before we
    // send synthetic input.
    std::thread::sleep(std::time::Duration::from_millis(60));

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo
        .key(Key::Control, Direction::Press)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Control, Direction::Release)
        .map_err(|e| e.to_string())?;

    Ok(true)
}
