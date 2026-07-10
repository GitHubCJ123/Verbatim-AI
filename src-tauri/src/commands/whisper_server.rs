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

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{ipc::Request, AppHandle, Manager, State};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::local_whisper::{
    resolve_whisper_server_launch, transcribe_args_from_pcm_request, write_pcm_wav, TranscribeArgs,
    TranscribeOutput, WhisperServerLaunch,
};

fn perf_enabled() -> bool {
    std::env::var("VERBATIM_PERF").ok().as_deref() == Some("1")
}

const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
const HEALTH_POLL: Duration = Duration::from_millis(150);
const DEFAULT_IDLE: Duration = Duration::from_secs(5 * 60);
const IDLE_CHECK: Duration = Duration::from_secs(30);

struct ServerHandle {
    child: Child,
    /// `"<tier>:<variant>"` — a change may be hot-swapped when the variant
    /// matches.
    key: String,
    variant_label: &'static str,
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
    idle_check: Duration,
    health_timeout: Duration,
    health_poll: Duration,
}

impl Default for WhisperServerState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            starting: Arc::new(Mutex::new(())),
            idle: DEFAULT_IDLE,
            idle_check: IDLE_CHECK,
            health_timeout: HEALTH_TIMEOUT,
            health_poll: HEALTH_POLL,
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
        self.ensure_launch(key, launch).await
    }

    async fn ensure_launch(
        &self,
        key: String,
        launch: WhisperServerLaunch,
    ) -> Result<String, String> {
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

        // Reuse a live same-variant server by asking whisper-server to load the
        // new model in-process. Any failure falls through to a fresh process.
        {
            let mut guard = self.inner.lock().await;
            if let Some(h) = guard.as_mut() {
                if h.is_alive() && h.variant_label == launch.variant_label {
                    let swap_started = Instant::now();
                    match load_model(&h.base_url, &launch.model_path).await {
                        Ok(()) => {
                            h.key = key;
                            h.variant_label = launch.variant_label;
                            h.last_used = Instant::now();
                            if perf_enabled() {
                                eprintln!(
                                    "[verbatim-perf] whisper-server load_swap_ms={} key={}",
                                    swap_started.elapsed().as_millis(),
                                    h.key
                                );
                            }
                            return Ok(h.base_url.clone());
                        }
                        Err(e) => {
                            if perf_enabled() {
                                eprintln!("[verbatim-perf] whisper-server load_swap_failed={e}");
                            }
                        }
                    }
                }
            }
        }

        // Drop any stale / wrong-variant / failed-swap server before allocating
        // a new one.
        {
            let mut guard = self.inner.lock().await;
            if let Some(mut h) = guard.take() {
                let _ = h.child.start_kill();
            }
        }

        let port = pick_free_port()?;
        let base_url = format!("http://127.0.0.1:{port}");

        let spawn_started = Instant::now();
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
            variant_label: launch.variant_label,
            base_url: base_url.clone(),
            last_used: Instant::now(),
        };

        if let Err(e) =
            wait_until_ready(&base_url, self.health_timeout, self.health_poll).await
        {
            let _ = handle.child.start_kill();
            return Err(e);
        }
        if perf_enabled() {
            eprintln!(
                "[verbatim-perf] whisper-server spawn_ms={} key={}",
                spawn_started.elapsed().as_millis(),
                handle.key
            );
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

    /// Best-effort synchronous termination for app shutdown (no async context).
    fn terminate_now(&self) {
        if let Ok(mut guard) = self.inner.try_lock() {
            if let Some(mut h) = guard.take() {
                let _ = h.child.start_kill();
            }
        }
    }

    fn spawn_idle_watcher(&self) {
        let inner = self.inner.clone();
        let idle = self.idle;
        let idle_check = self.idle_check;
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(idle_check).await;
                evict_idle_once(&inner, idle).await;
            }
        });
    }
}

async fn evict_idle_once(inner: &Arc<Mutex<Option<ServerHandle>>>, idle: Duration) {
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

async fn load_model(base_url: &str, model_path: &Path) -> Result<(), String> {
    let model = model_path.to_string_lossy().into_owned();
    let form = reqwest::multipart::Form::new().text("model", model);
    let resp = reqwest::Client::new()
        .post(format!("{base_url}/load"))
        .multipart(form)
        .timeout(HEALTH_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if resp.status().is_success() {
        return Ok(());
    }
    let code = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Err(format!("server returned {code}: {body}"))
}

fn pick_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

/// Poll the server root until it accepts connections (whisper-server starts
/// listening only after the model is loaded, so this doubles as a warm signal).
async fn wait_until_ready(base_url: &str, timeout: Duration, poll: Duration) -> Result<(), String> {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + timeout;
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
        tokio::time::sleep(poll).await;
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
pub async fn transcribe_local_server_pcm(
    app: AppHandle,
    state: State<'_, WhisperServerState>,
    request: Request<'_>,
) -> Result<TranscribeOutput, String> {
    let args = transcribe_args_from_pcm_request(&request)?;
    transcribe_local_server(app, state, args).await
}

/// Transcribe via the persistent server. Output matches `transcribe_local`.
// Internal implementation, invoked via the `transcribe_local_server_pcm`
// command; intentionally not registered as its own Tauri command.
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
    if perf_enabled() {
        eprintln!(
            "[verbatim-perf] whisper-server request_ms={}",
            wall_ms
        );
    }
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

/// Best-effort termination on shutdown. Call from `RunEvent::Exit`.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<WhisperServerState>() {
        state.terminate_now();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    fn test_state() -> WhisperServerState {
        WhisperServerState {
            inner: Arc::new(Mutex::new(None)),
            starting: Arc::new(Mutex::new(())),
            idle: Duration::from_millis(50),
            idle_check: Duration::from_millis(10),
            health_timeout: Duration::from_secs(3),
            health_poll: Duration::from_millis(20),
        }
    }

    fn test_dir(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("whisper-server-tests")
            .join(format!("{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_fake_server(dir: &Path) -> PathBuf {
        let script = dir.join("fake-whisper-server.py");
        fs::write(
            &script,
            r#"#!/usr/bin/env python3
import http.server
import os
import socketserver
import sys

port = None
for i, arg in enumerate(sys.argv):
    if arg == "--port" and i + 1 < len(sys.argv):
        port = int(sys.argv[i + 1])
if port is None:
    raise SystemExit("missing --port")

with open(__file__ + ".count", "a", encoding="utf-8") as f:
    f.write(str(os.getpid()) + "\n")

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        data = self.rfile.read(length) if length else b""
        if self.path == "/load":
            with open(__file__ + ".load", "a", encoding="utf-8") as f:
                f.write(data.decode("utf-8", "replace"))
                f.write("\n---load---\n")
            status_path = __file__ + ".load_status"
            status = ""
            if os.path.exists(status_path):
                with open(status_path, "r", encoding="utf-8") as f:
                    status = f.read().strip()
            if status == "fail":
                body = b"load failed"
                self.send_response(500)
            else:
                body = b"loaded"
                self.send_response(200)
            self.send_header("content-type", "text/plain")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = b'{"text":"fake transcript","language":"en"}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass

class Server(socketserver.TCPServer):
    allow_reuse_address = True

with Server(("127.0.0.1", port), Handler) as server:
    server.serve_forever()
"#,
        )
        .unwrap();
        let mut perms = fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script, perms).unwrap();
        script
    }

    fn launch_for(script: &Path, model: &Path, variant_label: &'static str) -> WhisperServerLaunch {
        WhisperServerLaunch {
            model_path: model.to_path_buf(),
            server_bin: script.to_path_buf(),
            variant_label,
            flash_attn: false,
        }
    }

    fn count_path(script: &Path) -> PathBuf {
        script.with_file_name(format!(
            "{}.count",
            script.file_name().unwrap().to_string_lossy()
        ))
    }

    fn spawn_count(script: &Path) -> usize {
        fs::read_to_string(count_path(script))
            .unwrap_or_default()
            .lines()
            .count()
    }

    fn load_path(script: &Path) -> PathBuf {
        script.with_file_name(format!(
            "{}.load",
            script.file_name().unwrap().to_string_lossy()
        ))
    }

    fn load_status_path(script: &Path) -> PathBuf {
        script.with_file_name(format!(
            "{}.load_status",
            script.file_name().unwrap().to_string_lossy()
        ))
    }

    fn load_log(script: &Path) -> String {
        fs::read_to_string(load_path(script)).unwrap_or_default()
    }

    fn load_count(script: &Path) -> usize {
        load_log(script).matches("---load---").count()
    }

    async fn assert_serves(base_url: &str) {
        let body = reqwest::get(base_url)
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "ok");
    }

    async fn wait_until_unreachable(base_url: &str) {
        let client = reqwest::Client::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let reachable = client
                .get(base_url)
                .timeout(Duration::from_millis(100))
                .send()
                .await
                .is_ok();
            if !reachable {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "server stayed reachable at {base_url}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[tokio::test]
    #[ignore = "flaky under full-suite parallelism; passes in isolation (see docs/testing/automated-testing-strategy.md)"]
    async fn concurrent_ensure_spawns_one_server() {
        let dir = test_dir("single-flight");
        let script = write_fake_server(&dir);
        let model = dir.join("model.bin");
        fs::write(&model, b"fake").unwrap();
        let state = Arc::new(test_state());
        let launch = launch_for(&script, &model, "cpu");

        let mut tasks = Vec::new();
        for _ in 0..8 {
            let state = state.clone();
            let launch = launch.clone();
            tasks.push(tokio::spawn(async move {
                state.ensure_launch("tiny:cpu".into(), launch).await.unwrap()
            }));
        }
        let urls = futures_util::future::join_all(tasks).await;
        let first = urls[0].as_ref().unwrap().clone();
        for url in urls {
            assert_eq!(url.unwrap(), first);
        }
        assert_serves(&first).await;
        assert_eq!(spawn_count(&script), 1);

        state.unload().await;
        wait_until_unreachable(&first).await;
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn same_key_reuses_existing_server() {
        let dir = test_dir("reuse");
        let script = write_fake_server(&dir);
        let model = dir.join("model.bin");
        fs::write(&model, b"fake").unwrap();
        let state = test_state();
        let launch = launch_for(&script, &model, "cpu");

        let first = state
            .ensure_launch("tiny:cpu".into(), launch.clone())
            .await
            .unwrap();
        let second = state.ensure_launch("tiny:cpu".into(), launch).await.unwrap();
        assert_eq!(first, second);
        assert_eq!(spawn_count(&script), 1);

        state.unload().await;
        wait_until_unreachable(&first).await;
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn different_model_same_variant_uses_load_endpoint() {
        let dir = test_dir("load-swap");
        let script = write_fake_server(&dir);
        let first_model = dir.join("tiny.bin");
        let second_model = dir.join("base.bin");
        fs::write(&first_model, b"fake").unwrap();
        fs::write(&second_model, b"fake").unwrap();
        let state = test_state();

        let first = state
            .ensure_launch(
                "tiny:cpu".into(),
                launch_for(&script, &first_model, "cpu"),
            )
            .await
            .unwrap();
        let second = state
            .ensure_launch(
                "base:cpu".into(),
                launch_for(&script, &second_model, "cpu"),
            )
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_serves(&second).await;
        assert_eq!(spawn_count(&script), 1);
        assert_eq!(load_count(&script), 1);
        assert!(load_log(&script).contains(
            second_model.to_string_lossy().as_ref()
        ));

        let third = state
            .ensure_launch(
                "base:cpu".into(),
                launch_for(&script, &second_model, "cpu"),
            )
            .await
            .unwrap();
        assert_eq!(second, third);
        assert_eq!(load_count(&script), 1);

        state.unload().await;
        wait_until_unreachable(&second).await;
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn load_failure_falls_back_to_respawn() {
        let dir = test_dir("load-fallback");
        let script = write_fake_server(&dir);
        fs::write(load_status_path(&script), b"fail").unwrap();
        let first_model = dir.join("tiny.bin");
        let second_model = dir.join("base.bin");
        fs::write(&first_model, b"fake").unwrap();
        fs::write(&second_model, b"fake").unwrap();
        let state = test_state();

        let first = state
            .ensure_launch(
                "tiny:cpu".into(),
                launch_for(&script, &first_model, "cpu"),
            )
            .await
            .unwrap();
        let second = state
            .ensure_launch(
                "base:cpu".into(),
                launch_for(&script, &second_model, "cpu"),
            )
            .await
            .unwrap();
        assert_ne!(first, second);
        wait_until_unreachable(&first).await;
        assert_serves(&second).await;
        assert_eq!(spawn_count(&script), 2);
        assert_eq!(load_count(&script), 1);

        state.unload().await;
        wait_until_unreachable(&second).await;
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn variant_change_respawns_without_load_attempt() {
        let dir = test_dir("variant-respawn");
        let script = write_fake_server(&dir);
        let model = dir.join("model.bin");
        fs::write(&model, b"fake").unwrap();
        let state = test_state();

        let first = state
            .ensure_launch("tiny:cpu".into(), launch_for(&script, &model, "cpu"))
            .await
            .unwrap();
        let second = state
            .ensure_launch("tiny:metal".into(), launch_for(&script, &model, "metal"))
            .await
            .unwrap();
        assert_ne!(first, second);
        wait_until_unreachable(&first).await;
        assert_serves(&second).await;
        assert_eq!(spawn_count(&script), 2);
        assert_eq!(load_count(&script), 0);

        state.unload().await;
        wait_until_unreachable(&second).await;
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn idle_eviction_stops_server() {
        let dir = test_dir("idle");
        let script = write_fake_server(&dir);
        let model = dir.join("model.bin");
        fs::write(&model, b"fake").unwrap();
        let state = test_state();

        let url = state
            .ensure_launch("tiny:cpu".into(), launch_for(&script, &model, "cpu"))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(75)).await;
        evict_idle_once(&state.inner, state.idle).await;
        wait_until_unreachable(&url).await;

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn dead_handle_is_respawned() {
        let dir = test_dir("dead");
        let script = write_fake_server(&dir);
        let model = dir.join("model.bin");
        fs::write(&model, b"fake").unwrap();
        let state = test_state();
        let launch = launch_for(&script, &model, "cpu");

        let first = state
            .ensure_launch("tiny:cpu".into(), launch.clone())
            .await
            .unwrap();
        {
            let mut guard = state.inner.lock().await;
            let handle = guard.as_mut().unwrap();
            let _ = handle.child.start_kill();
            let _ = handle.child.wait().await;
        }
        wait_until_unreachable(&first).await;

        let second = state
            .ensure_launch("tiny:cpu".into(), launch)
            .await
            .unwrap();
        assert_ne!(first, second);
        assert_serves(&second).await;
        assert_eq!(spawn_count(&script), 2);

        state.unload().await;
        wait_until_unreachable(&second).await;
        let _ = fs::remove_dir_all(&dir);
    }
}
