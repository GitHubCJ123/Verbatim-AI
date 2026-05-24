//! Cross-window event relay.
//!
//! In Tauri 2 the JS `emit()` from one webview does not reliably reach
//! listeners in other webviews on Windows (we hit this with the
//! overlay → main `recording:result` path). The Rust-side `Emitter`
//! broadcast does work, so the overlay sends events through this
//! command instead.

use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};

#[tauri::command]
pub fn relay_event<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    payload: Value,
) -> Result<(), String> {
    app.emit(&name, payload).map_err(|e| e.to_string())
}
