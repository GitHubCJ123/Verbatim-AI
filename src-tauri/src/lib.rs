mod commands;
mod tray;

use commands::{
    active_window::get_active_window,
    devtools::{open_devtools, open_main_devtools},
    hotkey::{clear_hotkey, handle_event as handle_hotkey_event, install_default, set_hotkey, HotkeyState},
    local_whisper::{
        delete_local_model, download_local_model, install_whisper_runtime,
        is_whisper_runtime_installed, list_local_models, transcribe_local,
    },
    parakeet::{
        delete_parakeet_model, download_parakeet_model, install_parakeet_runtime,
        is_parakeet_model_installed, is_parakeet_runtime_installed, transcribe_parakeet,
    },
    paste::{capture_target_window, clear_target_window, paste_to_target, TargetWindowState},
    process_list::list_running_apps,
    relay::relay_event,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Auto-accept the WebView2 mic permission prompt. The fake-UI flag makes
    // Chromium silently grant any media prompt; the user already gave OS-level
    // mic consent during onboarding.
    #[cfg(windows)]
    {
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let extra = "--use-fake-ui-for-media-stream";
        let merged = if existing.is_empty() {
            extra.to_string()
        } else {
            format!("{existing} {extra}")
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
    }

    tauri::Builder::default()
        .manage(HotkeyState::default())
        .manage(TargetWindowState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    handle_hotkey_event(app, shortcut, event);
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_active_window,
            set_hotkey,
            clear_hotkey,
            list_running_apps,
            capture_target_window,
            clear_target_window,
            paste_to_target,
            relay_event,
            list_local_models,
            download_local_model,
            delete_local_model,
            transcribe_local,
            is_whisper_runtime_installed,
            install_whisper_runtime,
            is_parakeet_runtime_installed,
            install_parakeet_runtime,
            is_parakeet_model_installed,
            download_parakeet_model,
            delete_parakeet_model,
            transcribe_parakeet,
            open_devtools,
            open_main_devtools,
        ])
        .setup(|app| {
            install_default(&app.handle());
            tray::install(&app.handle())?;
            // Close-to-hide for the main window (plan §5 lifecycle).
            if let Some(window) = app.get_webview_window("main") {
                // Fit the window to the available monitor so all UI is visible.
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let avail_w = (size.width as f64) / scale;
                    let avail_h = (size.height as f64) / scale;
                    let target_w = avail_w.min(1280.0).max(880.0);
                    let target_h = (avail_h - 60.0).min(820.0).max(620.0);
                    let _ = window.set_size(tauri::LogicalSize::new(target_w, target_h));
                    let _ = window.center();
                }
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }
            // Mark overlay as no-activate so it never steals focus when shown.
            #[cfg(windows)]
            if let Some(overlay) = app.get_webview_window("overlay") {
                if let Ok(hwnd) = overlay.hwnd() {
                    use windows::Win32::UI::WindowsAndMessaging::{
                        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
                    };
                    unsafe {
                        let h = windows::Win32::Foundation::HWND(hwnd.0 as *mut _);
                        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
                        SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize);
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
