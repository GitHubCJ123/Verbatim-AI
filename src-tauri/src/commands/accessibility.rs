//! macOS Accessibility (AX) permission.
//!
//! Posting synthetic keystrokes — the ⌘V / direct-type paste we drive
//! through `enigo` — requires the **Accessibility** permission on macOS.
//! Without it macOS silently drops the events, so a paste "succeeds"
//! (enigo returns Ok) while nothing is actually typed. That silent
//! no-op is what makes a failed paste look like a mysterious broken
//! review pop-up to the user.
//!
//! This module surfaces the permission state explicitly so the frontend
//! can guide the user, mirroring the Input Monitoring flow in
//! [`super::fn_hotkey`]. `paste_to_target` / `insert_text_to_target`
//! preflight [`ensure_accessibility`] and return the [`NEEDS_ACCESSIBILITY`]
//! sentinel when the grant is missing.
//!
//! Because the macOS build is unsigned / ad-hoc-signed, macOS drops this
//! grant on **every update** (the code identity changes), so the user has
//! to re-grant and relaunch each time. The permanent fix is Developer ID
//! signing + notarization, which keeps the grant stable across updates.

/// Sentinel error the frontend matches to show a friendly Accessibility
/// permission prompt instead of a raw error string.
pub const NEEDS_ACCESSIBILITY: &str =
    "needs-accessibility: grant Accessibility to Verbatim AI in System Settings → \
     Privacy & Security → Accessibility, then relaunch the app and try again.";

/// Returns `true` when the process is trusted for Accessibility (allowed
/// to post synthetic input). Always `true` on non-macOS, which have no
/// equivalent gate for the paste path.
#[tauri::command]
pub fn check_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::is_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Show the system Accessibility prompt (first time) and add the app to
/// the System Settings list. Returns the trust state after prompting.
/// No-op returning `true` on non-macOS. Only ever invoked from an explicit
/// user action — never automatically — so it can't spam prompts.
#[tauri::command]
pub fn request_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::request_trust()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Open the Accessibility pane of System Settings so the user can grant
/// access without hunting for it. Errors as "macOS only" elsewhere.
#[tauri::command]
pub fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("macOS only.".into())
    }
}

/// Preflight for the paste commands. `Ok(())` when trusted (or non-macOS);
/// `Err(NEEDS_ACCESSIBILITY)` when the grant is missing so the caller can
/// short-circuit with a guiding sentinel instead of a silent no-op.
///
/// This is a **silent** check — it never shows the system prompt (that is
/// owned by [`request_accessibility_permission`], invoked from a button).
pub fn ensure_accessibility() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if macos::is_trusted() {
            Ok(())
        } else {
            Err(NEEDS_ACCESSIBILITY.to_string())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    /// Silent trust check — never prompts.
    pub fn is_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// Trust check that shows the system prompt when not yet granted.
    pub fn request_trust() -> bool {
        unsafe {
            // `kAXTrustedCheckOptionPrompt: true` asks macOS to show the
            // permission prompt and add us to the Accessibility list.
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let value = CFBoolean::true_value();
            let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sentinel_is_matchable_and_actionable() {
        // The frontend matches on the "needs-accessibility" prefix; keep it
        // stable and keep the relaunch guidance in the message.
        assert!(super::NEEDS_ACCESSIBILITY.starts_with("needs-accessibility"));
        assert!(super::NEEDS_ACCESSIBILITY.contains("relaunch"));
        assert!(super::NEEDS_ACCESSIBILITY.contains("Accessibility"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_never_blocks_paste() {
        // No AX gate off macOS — the preflight must always pass so paste
        // is never spuriously turned into a permission error.
        assert!(super::ensure_accessibility().is_ok());
        assert!(super::check_accessibility_permission());
        assert!(super::request_accessibility_permission());
    }
}
