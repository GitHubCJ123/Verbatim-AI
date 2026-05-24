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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
