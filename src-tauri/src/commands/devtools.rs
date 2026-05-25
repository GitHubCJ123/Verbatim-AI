use tauri::{Manager, WebviewWindow};

#[tauri::command]
pub fn open_devtools(window: WebviewWindow) -> Result<(), String> {
    // Open dev tools for the window that invoked this command.
    window.open_devtools();
    Ok(())
}

#[tauri::command]
pub fn open_main_devtools(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        main.open_devtools();
        Ok(())
    } else {
        Err("main window not found".into())
    }
}
