//! Pre-flight check for the in-place auto-updater on macOS.
//!
//! Tauri's updater replaces the `.app` bundle of the *currently running*
//! executable (see tauri-plugin-updater `extract_path_from_executable`).
//! When an unsigned / un-notarized build is quarantined, macOS launches it
//! from a randomized, read-only **App Translocation** copy under
//! `/private/var/folders/.../AppTranslocation/...`. The updater then swaps
//! that ephemeral copy instead of the real `/Applications` install, so the
//! user's app never actually updates. The same happens when the app is run
//! from a read-only volume (a mounted `.dmg`).
//!
//! This command lets the frontend detect those cases and offer a manual
//! update path instead of silently "updating" into a throwaway folder.

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallEnvironment {
    /// True when an in-place auto-update can actually replace the running app.
    pub can_auto_install: bool,
    /// Machine-readable reason when `can_auto_install` is false:
    /// `"translocated"` or `"read_only_volume"`.
    pub reason: Option<String>,
    /// Resolved `.app` bundle path of the running executable (best effort).
    pub bundle_path: Option<String>,
}

#[cfg(target_os = "macos")]
fn bundle_path_from_exe(exe: &std::path::Path) -> Option<String> {
    // .../Foo.app/Contents/MacOS/foo  ->  .../Foo.app
    let mut cur = exe;
    while let Some(parent) = cur.parent() {
        if parent.extension().map(|e| e == "app").unwrap_or(false) {
            return Some(parent.display().to_string());
        }
        cur = parent;
    }
    exe.parent().map(|p| p.display().to_string())
}

#[tauri::command]
pub fn update_install_environment() -> UpdateInstallEnvironment {
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().unwrap_or_default();
        let exe_str = exe.to_string_lossy();
        let bundle_path = bundle_path_from_exe(&exe);
        if exe_str.contains("/AppTranslocation/") {
            return UpdateInstallEnvironment {
                can_auto_install: false,
                reason: Some("translocated".into()),
                bundle_path,
            };
        }
        if exe_str.starts_with("/Volumes/") {
            return UpdateInstallEnvironment {
                can_auto_install: false,
                reason: Some("read_only_volume".into()),
                bundle_path,
            };
        }
        UpdateInstallEnvironment {
            can_auto_install: true,
            reason: None,
            bundle_path,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows (NSIS) and Linux updaters install in place correctly.
        let bundle_path = std::env::current_exe()
            .ok()
            .map(|p| p.display().to_string());
        UpdateInstallEnvironment {
            can_auto_install: true,
            reason: None,
            bundle_path,
        }
    }
}
