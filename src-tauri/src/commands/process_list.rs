//! Enumerate running apps that have a visible top-level window.
//!
//! Returns one entry per unique executable. Used by the "Add app"
//! picker in Settings → Apps (plan §8.3 / §9.5).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RunningApp {
    pub exe: String,
    pub exe_path: String,
    pub title: String,
    pub pid: u32,
}

#[cfg(windows)]
mod imp {
    use super::RunningApp;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use windows::Win32::Foundation::{BOOL, CloseHandle, HWND, LPARAM, MAX_PATH};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
    };

    struct Collector {
        apps: HashMap<String, RunningApp>,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let collector = &mut *(lparam.0 as *mut Collector);

            if !IsWindowVisible(hwnd).as_bool() {
                return BOOL(1);
            }
            // Skip tool windows (tray, hidden helper UIs).
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW.0 != 0 {
                return BOOL(1);
            }
            // Skip windows that have an owner — typically dialogs of a primary window.
            if !GetWindow(hwnd, GW_OWNER).unwrap_or(HWND::default()).0.is_null() {
                return BOOL(1);
            }

            // Title must be non-empty.
            let title_len = GetWindowTextLengthW(hwnd);
            if title_len <= 0 {
                return BOOL(1);
            }
            let mut tbuf = vec![0u16; (title_len as usize) + 1];
            let read = GetWindowTextW(hwnd, &mut tbuf);
            if read <= 0 {
                return BOOL(1);
            }
            let title = String::from_utf16_lossy(&tbuf[..read as usize]);

            // Resolve process exe.
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return BOOL(1);
            }
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return BOOL(1);
            };

            let mut pbuf = vec![0u16; MAX_PATH as usize];
            let mut psize: u32 = pbuf.len() as u32;
            let exe_path = if QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(pbuf.as_mut_ptr()),
                &mut psize,
            )
            .is_ok()
            {
                String::from_utf16_lossy(&pbuf[..psize as usize])
            } else {
                String::new()
            };
            let _ = CloseHandle(handle);

            let exe = PathBuf::from(&exe_path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            if exe.is_empty() {
                return BOOL(1);
            }

            // Dedupe per-exe; keep the first visible window we see.
            collector.apps.entry(exe.to_lowercase()).or_insert(RunningApp {
                exe,
                exe_path,
                title,
                pid,
            });

            BOOL(1)
        }
    }

    pub fn list() -> Vec<RunningApp> {
        let mut collector = Collector { apps: HashMap::new() };
        unsafe {
            let _ = EnumWindows(
                Some(enum_proc),
                LPARAM(&mut collector as *mut _ as isize),
            );
        }
        let mut v: Vec<RunningApp> = collector.apps.into_values().collect();
        v.sort_by(|a, b| a.exe.to_lowercase().cmp(&b.exe.to_lowercase()));
        v
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::RunningApp;
    use objc2::msg_send;
    use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};

    pub fn list() -> Vec<RunningApp> {
        unsafe {
            let workspace = NSWorkspace::sharedWorkspace();
            let apps = workspace.runningApplications();
            let count = apps.count();
            let mut out: Vec<RunningApp> = Vec::new();
            for i in 0..count {
                let app = apps.objectAtIndex(i);
                // Only "regular" apps (have a Dock icon / appear in ⌘Tab).
                if app.activationPolicy() != NSApplicationActivationPolicy::Regular {
                    continue;
                }
                let exe = app
                    .localizedName()
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                if exe.is_empty() {
                    continue;
                }
                let exe_path = app
                    .bundleURL()
                    .and_then(|u| u.path())
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                let pid: i32 = msg_send![&*app, processIdentifier];
                out.push(RunningApp {
                    exe,
                    exe_path,
                    title: String::new(),
                    pid: pid as u32,
                });
            }
            out.sort_by(|a, b| a.exe.to_lowercase().cmp(&b.exe.to_lowercase()));
            out
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::RunningApp;
    pub fn list() -> Vec<RunningApp> {
        Vec::new()
    }
}

#[tauri::command]
pub fn list_running_apps() -> Vec<RunningApp> {
    imp::list()
}
