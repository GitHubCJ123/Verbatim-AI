//! System tray icon + menu (plan §8.10).
//!
//! Single-state icon for v1; the per-state color tint (gray / violet /
//! cyan / red) is a Phase 13 polish task because it needs 4 baked PNGs.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open SuperWisper", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&open, &separator, &settings, &separator2, &quit],
    )?;

    let _tray = TrayIconBuilder::with_id("main")
        .tooltip("SuperWisper")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            // Fallback: should never hit because tauri builds always include
            // the default window icon, but keep this code path explicit.
            tauri::image::Image::new_owned(vec![], 0, 0)
        }))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "settings" => {
                show_main_window(app);
                let _ = app.emit("tray:settings", ());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
