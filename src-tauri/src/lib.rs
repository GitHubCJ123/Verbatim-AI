mod commands;

use commands::{
    active_window::get_active_window,
    hotkey::{clear_hotkey, handle_event as handle_hotkey_event, install_default, set_hotkey, HotkeyState},
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(HotkeyState::default())
        .plugin(tauri_plugin_opener::init())
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
        ])
        .setup(|app| {
            install_default(&app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
