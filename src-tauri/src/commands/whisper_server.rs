//! Persistent `whisper-server` sidecar (issue #23, P0).
//!
//! Instead of spawning `whisper-cli` per utterance (a cold model load every
//! time), we run the official whisper.cpp `whisper-server` binary once and keep
//! the model resident, transcribing over a loopback HTTP request. This is a
//! clean-room reimplementation of the "warm resident model" idea; no third-party
//! source is copied.
//!
//! The server binary is resolved from the same runtime layout as `whisper-cli`
//! (see `local_whisper::resolve_whisper_server_launch`) so GPU-variant selection
//! and model files are reused unchanged.

use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::local_whisper::{resolve_whisper_server_launch, write_pcm_wav, TranscribeArgs, TranscribeOutput};

const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
const HEALTH_POLL: Duration = Duration::from_millis(150);
const DEFAULT_IDLE: Duration = Duration::from_secs(5 * 60);
const IDLE_CHECK: Duration = Duration::from_secs(30);

struct ServerHandle {
    child: Child,
    /// `"<tier>:<variant>"` — a change forces a respawn.
    key: String,
    base_url: String,
    last_used: Instant,
}

impl ServerHandle {
    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

/// Managed Tauri state holding the single warm server (if any).
pub struct WhisperServerState {
    inner: Arc<Mutex<Option<ServerHandle>>>,
    /// Serializes spawns so concurrent hotkey presses don't launch two servers.
    starting: Arc<Mutex<()>>,
    idle: Duration,
}

impl Default for WhisperServerState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            starting: Arc::new(Mutex::new(())),
            idle: DEFAULT_IDLE,
        }
    }
}

impl WhisperServerState {
    /// Ensure a warm server for `(tier, variant)` is running; return its base URL.
    async fn ensure(
        &self,
        app: &AppHandle,
        tier: &str,
        compute: Option<&str>,
    ) -> Result<String, String> {
        let launch = resolve_whisper_server_launch(app, tier, compute)?;
        let key = format!("{tier}:{}", launch.variant_label);

        // Fast path: reuse a live matching server.
        {
            let mut guard = self.inner.lock().await;
            if let Some(h) = guard.as_mut() {
                if h.key == key && h.is_alive() {
                    h.last_used = Instant::now();
                    return Ok(h.base_url.clone());
                }
            }
        }

        // Single-flight: only one spawn at a time.
        let _starting = self.starting.lock().await;

        // Re-check: another caller may have started the right server meanwhile.
        {
            let mut guard = self.inner.lock().await;
            if let Some(h) = guard.as_mut() {
                if h.key == key && h.is_alive() {
                    h.last_used = Instant::now();
                    return Ok(h.base_url.clone());
                }
            }
        }

        // Drop any stale / other-model server before allocating a new one.
        {
            let mut guard = self.inner.lock().await;
            if let Some(mut h) = guard.take() {
                let _ = h.child.start_kill();
            }
        }

        let port = pick_free_port()?;
        let base_url = format!("http://127.0.0.1:{port}");

        let mut cmd = Command::new(&launch.server_bin);
        cmd.arg("-m")
            .arg(&launch.model_path)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string());
        if launch.flash_attn {
            cmd.arg("-fa");
        }
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        cmd.kill_on_drop(true);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("failed to start whisper-server: {e}"))?;

        let mut handle = ServerHandle {
            child,
            key,
            base_url: base_url.clone(),
            last_used: Instant::now(),
        };

        if let Err(e) = wait_until_ready(&base_url).await {
            let _ = handle.child.start_kill();
            return Err(e);
        }

        let mut guard = self.inner.lock().await;
        *guard = Some(handle);
        Ok(base_url)
    }

    async fn unload(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(mut h) = guard.take() {
            let _ = h.child.start_kill();
        }
    }

    /// Best-effort synchronous kill for app shutdown (no async context).
    fn kill_now(&self) {
        if let Ok(mut guard) = self.inner.try_lock() {
            if let Some(mut h) = guard.take() {
                let _ = h.child.start_kill();
            }
        }
    }

    fn spawn_idle_watcher(&self) {
        let inner = self.inner.clone();
        let idle = self.idle;
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(IDLE_CHECK).await;
                let mut guard = inner.lock().await;
                let stale = guard
                    .as_ref()
                    .map(|h| h.last_used.elapsed() > idle)
                    .unwrap_or(false);
                if stale {
                    if let Some(mut h) = guard.take() {
                        let _ = h.child.start_kill();
                    }
                }
            }
        });
    }
}

fn pick_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

/// Poll the server root until it accepts connections (whisper-server starts
/// listening only after the model is loaded, so this doubles as a warm signal).
async fn wait_until_ready(base_url: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    loop {
        let ok = client
            .get(base_url)
            .timeout(Duration::from_millis(800))
            .send()
            .await
            .is_ok();
        if ok {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("whisper-server did not become ready in time".into());
        }
        tokio::time::sleep(HEALTH_POLL).await;
    }
}

#[tauri::command]
pub async fn ensure_engine_ready(
    app: AppHandle,
    state: State<'_, WhisperServerState>,
    tier: String,
    compute_preference: Option<String>,
) -> Result<(), String> {
    state
        .ensure(&app, &tier, compute_preference.as_deref())
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn unload_engine(state: State<'_, WhisperServerState>) -> Result<(), String> {
    state.unload().await;
    Ok(())
}

/// Whether the warm-server path is usable (the `whisper-server` binary exists
/// for the selected compute variant). Lets the frontend auto-detect and fall
/// back to the `whisper-cli` path when the server isn't installed.
#[tauri::command]
pub fn is_whisper_server_available(app: AppHandle, preference: Option<String>) -> bool {
    super::local_whisper::whisper_server_available(&app, preference.as_deref())
}

/// Transcribe via the persistent server. Output matches `transcribe_local`.
#[tauri::command]
pub async fn transcribe_local_server(
    app: AppHandle,
    state: State<'_, WhisperServerState>,
    args: TranscribeArgs,
) -> Result<TranscribeOutput, String> {
    if args.pcm.is_empty() {
        return Err("Empty audio buffer".into());
    }
    let base_url = state
        .ensure(&app, &args.tier, args.compute_preference.as_deref())
        .await?;

    let wav_path = write_pcm_wav(&app, &args.pcm)?;
    let wav_bytes = tokio::fs::read(&wav_path).await.map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_file(&wav_path).await;

    let language = args.language.clone().unwrap_or_else(|| "auto".to_string());
    let translate = args.translate.unwrap_or(false);

    let mut form = reqwest::multipart::Form::new()
        .part(
            "file",
            reqwest::multipart::Part::bytes(wav_bytes)
                .file_name("audio.wav")
                .mime_str("audio/wav")
                .map_err(|e| e.to_string())?,
        )
        .text("response_format", "verbose_json")
        .text("no_timestamps", "true")
        .text("language", language.clone());
    if translate {
        form = form.text("translate", "true");
    }

    let client = reqwest::Client::new();
    let started = Instant::now();
    let resp = client
        .post(format!("{base_url}/inference"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("whisper-server request failed: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("whisper-server error {code}: {body}"));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("failed to read whisper-server response: {e}"))?;
    let wall_ms = started.elapsed().as_millis() as u64;
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("invalid whisper-server response: {e}"))?;

    let text = value
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    let language_detected = value
        .get("language")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(language.as_str())
        .to_string();

    Ok(TranscribeOutput {
        text,
        language_detected,
        duration_ms: wall_ms,
    })
}

/// Start the idle-unload watcher. Call once from `setup`.
pub fn init(app: &AppHandle) {
    if let Some(state) = app.try_state::<WhisperServerState>() {
        state.spawn_idle_watcher();
    }
}

/// Best-effort kill on shutdown. Call from `RunEvent::Exit`.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<WhisperServerState>() {
        state.kill_now();
    }
}
