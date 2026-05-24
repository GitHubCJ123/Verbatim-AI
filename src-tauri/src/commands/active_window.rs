//! Windows active-window probe.
//!
//! Reads the foreground window's title and the executable path of the
//! owning process. Used to pick a Mode at hotkey-press time (plan §13).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ActiveWindow {
    pub exe: String,
    pub exe_path: String,
    pub title: String,
}

#[cfg(windows)]
mod imp {
    use super::ActiveWindow;
    use std::path::PathBuf;
    use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    pub fn get() -> ActiveWindow {
        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.0.is_null() {
                return ActiveWindow::default();
            }

            // Title
            let title_len = GetWindowTextLengthW(hwnd);
            let mut title = String::new();
            if title_len > 0 {
                let mut buf = vec![0u16; (title_len as usize) + 1];
                let read = GetWindowTextW(hwnd, &mut buf);
                if read > 0 {
                    title = String::from_utf16_lossy(&buf[..read as usize]);
                }
            }

            // Owning process
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return ActiveWindow {
                    exe: String::new(),
                    exe_path: String::new(),
                    title,
                };
            }

            let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(h) => h,
                Err(_) => {
                    return ActiveWindow {
                        exe: String::new(),
                        exe_path: String::new(),
                        title,
                    };
                }
            };

            let mut path_buf = vec![0u16; MAX_PATH as usize];
            let mut path_size: u32 = path_buf.len() as u32;
            let exe_path = if QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(path_buf.as_mut_ptr()),
                &mut path_size,
            )
            .is_ok()
            {
                String::from_utf16_lossy(&path_buf[..path_size as usize])
            } else {
                String::new()
            };
            let _ = CloseHandle(handle);

            let exe = PathBuf::from(&exe_path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            ActiveWindow {
                exe,
                exe_path,
                title,
            }
        }
    }
}

impl Default for ActiveWindow {
    fn default() -> Self {
        Self {
            exe: String::new(),
            exe_path: String::new(),
            title: String::new(),
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::ActiveWindow;
    use objc2_app_kit::NSWorkspace;

    pub fn get() -> ActiveWindow {
        unsafe {
            let workspace = NSWorkspace::sharedWorkspace();
            let Some(app) = workspace.frontmostApplication() else {
                return ActiveWindow::default();
            };
            let exe = app
                .localizedName()
                .map(|s| s.to_string())
                .unwrap_or_default();
            let exe_path = app
                .bundleURL()
                .and_then(|u| u.path())
                .map(|s| s.to_string())
                .unwrap_or_default();
            // Window title is expensive/permission-gated on macOS
            // (CGWindowListCopyWindowInfo needs Screen Recording perm to
            // see other apps' titles). Leave empty for now — app
            // resolution still works on `exe`.
            ActiveWindow {
                exe,
                exe_path,
                title: String::new(),
            }
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::ActiveWindow;
    pub fn get() -> ActiveWindow {
        ActiveWindow::default()
    }
}

#[tauri::command]
pub fn get_active_window() -> ActiveWindow {
    imp::get()
}
