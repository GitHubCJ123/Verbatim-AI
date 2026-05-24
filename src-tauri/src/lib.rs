mod commands;
mod tray;

use commands::{
    active_window::get_active_window,
    hotkey::{clear_hotkey, handle_event as handle_hotkey_event, install_default, set_hotkey, HotkeyState},
    paste::{capture_target_window, clear_target_window, paste_to_target, TargetWindowState},
    process_list::list_running_apps,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        ])
        .setup(|app| {
            install_default(&app.handle());
            tray::install(&app.handle())?;
            // Close-to-hide for the main window (plan §5 lifecycle).
            if let Some(window) = app.get_webview_window("main") {
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
