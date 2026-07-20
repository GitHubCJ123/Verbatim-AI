mod commands;
mod tray;

use commands::{
    active_window::get_active_window,
    cancel_hotkey::{disable_cancel_shortcut, enable_cancel_shortcut, CancelHotkeyState},
    devtools::{open_devtools, open_main_devtools},
    fn_hotkey::{open_input_monitoring_settings, FnHotkeyState},
    hotkey::{clear_hotkey, handle_event as handle_hotkey_event, install_default, set_hotkey, HotkeyState},
    llama_cpp::{
        cleanup_llama_cpp, install_llama_cpp_runtime, is_llama_cpp_runtime_installed,
    },
    local_whisper::{
        delete_local_model, detect_whisper_compute_backend, download_local_model,
        get_active_whisper_runtime_variant, install_whisper_runtime,
        is_whisper_runtime_installed, list_custom_whisper_models, list_local_models,
        rescan_local_models, transcribe_local_pcm,
    },
    native_audio::{
        arm_native_capture, cancel_native_session, disarm_native_capture, is_native_capture_armed,
        start_native_capture, start_native_session, stop_native_capture, stop_native_session,
        take_native_recording, NativeCaptureState,
    },
    parakeet::{
        delete_parakeet_model, download_parakeet_model, install_parakeet_runtime,
        is_parakeet_model_installed, is_parakeet_runtime_installed, list_parakeet_models,
        transcribe_parakeet,
    },
    paste::{
        capture_target_window, clear_target_window, insert_text_to_target, paste_to_target,
        TargetWindowState,
    },
    process_list::list_running_apps,
    relay::relay_event,
    streaming_sidecar::{
        finish_streaming_session, is_streaming_sidecar_available, push_streaming_frames,
        start_streaming_session, stop_streaming_session, StreamingSidecarState,
    },
    updater_env::update_install_environment,
    whisper_server::{
        ensure_engine_ready, is_whisper_server_available, transcribe_local_server_pcm,
        unload_engine, WhisperServerState,
    },
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

    let mut builder = tauri::Builder::default();

    // Single-instance: if the app is already running, the new launch's
    // callback fires in the existing process — focus its window instead of
    // opening a second window. Must be registered before other plugins.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .manage(HotkeyState::default())
        .manage(FnHotkeyState::default())
        .manage(CancelHotkeyState::default())
        .manage(TargetWindowState::default())
        .manage(WhisperServerState::default())
        .manage(StreamingSidecarState::default())
        .manage(NativeCaptureState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
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
            enable_cancel_shortcut,
            disable_cancel_shortcut,
            list_running_apps,
            capture_target_window,
            clear_target_window,
            insert_text_to_target,
            paste_to_target,
            relay_event,
            list_local_models,
            list_custom_whisper_models,
            rescan_local_models,
            download_local_model,
            delete_local_model,
            transcribe_local_pcm,
            is_whisper_runtime_installed,
            detect_whisper_compute_backend,
            get_active_whisper_runtime_variant,
            install_whisper_runtime,
            is_parakeet_runtime_installed,
            install_parakeet_runtime,
            is_parakeet_model_installed,
            list_parakeet_models,
            download_parakeet_model,
            delete_parakeet_model,
            transcribe_parakeet,
            is_llama_cpp_runtime_installed,
            install_llama_cpp_runtime,
            cleanup_llama_cpp,
            open_devtools,
            open_main_devtools,
            open_input_monitoring_settings,
            update_install_environment,
            ensure_engine_ready,
            unload_engine,
            transcribe_local_server_pcm,
            is_whisper_server_available,
            is_streaming_sidecar_available,
            start_streaming_session,
            push_streaming_frames,
            finish_streaming_session,
            stop_streaming_session,
            arm_native_capture,
            disarm_native_capture,
            start_native_session,
            stop_native_session,
            take_native_recording,
            cancel_native_session,
            is_native_capture_armed,
            start_native_capture,
            stop_native_capture,
        ])
        .setup(|app| {
            install_default(&app.handle());
            tray::install(&app.handle())?;
            commands::whisper_server::init(&app.handle());
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                crate::tray::show_main_window(app_handle);
            }
            if let tauri::RunEvent::Exit = event {
                commands::whisper_server::shutdown(app_handle);
                commands::streaming_sidecar::shutdown(app_handle);
            }
        });
}
