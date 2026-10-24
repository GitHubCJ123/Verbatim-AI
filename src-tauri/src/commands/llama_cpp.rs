//! Built-in text cleanup ("AI polish") on a resident llama.cpp server.
//!
//! The official prebuilt llama.cpp runtime and a small curated set of GGUF
//! models are downloaded into the app data dir, each verified against a
//! pinned SHA-256. Cleanup runs on one long-lived `llama-server` bound to
//! loopback with a per-launch API key, so the model is loaded once instead of
//! on every dictation.
//!
//! Layout under `app_data_dir`:
//!   llama-cpp-bin/llama-<build>/llama-server(.exe)  (+ shared libraries)
//!   cleanup-models/<file>.gguf

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use super::runtime_assets::{
    download_with_progress, extract_archive, locate_executable, make_executables,
    strip_quarantine, verify_sha256, ArchiveKind, DownloadProgress as RuntimeAssetProgress,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::fs;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
const HEALTH_POLL: Duration = Duration::from_millis(100);
/// A cold model load costs 1–3 s, so keep it resident across normal pauses.
const DEFAULT_IDLE: Duration = Duration::from_secs(30 * 60);
const IDLE_CHECK: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
const CONTEXT_TOKENS: u32 = 8192;

pub struct CleanupModel {
    pub id: &'static str,
    file: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
}

/// URLs are pinned to a Hugging Face commit; `sha256` is the file's LFS oid.
pub const CLEANUP_MODELS: &[CleanupModel] = &[
    CleanupModel {
        id: "qwen3.5-0.8b",
        file: "Qwen3.5-0.8B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q4_K_M.gguf",
        sha256: "bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517",
        size: 532_517_120,
    },
    CleanupModel {
        id: "qwen3.5-2b",
        file: "Qwen3.5-2B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf",
        sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
        size: 1_280_835_840,
    },
    CleanupModel {
        id: "qwen3-4b-2507",
        file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
        size: 2_497_281_120,
    },
    CleanupModel {
        id: "qwen3.5-4b",
        file: "Qwen3.5-4B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf",
        sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
        size: 2_740_937_888,
    },
];

fn model_by_id(id: &str) -> Result<&'static CleanupModel, String> {
    CLEANUP_MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("Unknown cleanup model: {id}"))
}

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data(app)?.join("llama-cpp-bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data(app)?.join("cleanup-models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn model_path(app: &AppHandle, model: &CleanupModel) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(model.file))
}

fn llama_server_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

fn locate_llama_server(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    Ok(locate_executable(&bin_dir(app)?, llama_server_name()))
}

struct RuntimeAsset {
    name: &'static str,
    url: &'static str,
    sha256: &'static str,
}

fn runtime_asset() -> Result<RuntimeAsset, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Ok(RuntimeAsset {
            name: "llama-b9874-bin-macos-arm64.tar.gz",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b9874/llama-b9874-bin-macos-arm64.tar.gz",
            sha256: "6ad88c0f70c4731200e514132043b08894238beebf1a8e80e2b14a0ebecd1cb8",
        })
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Ok(RuntimeAsset {
            name: "llama-b9874-bin-macos-x64.tar.gz",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b9874/llama-b9874-bin-macos-x64.tar.gz",
            sha256: "ba4509c4b71bc6ff1abb00185c203967a8487c991500ccf4839c5ea5422cd1a6",
        })
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        Ok(RuntimeAsset {
            name: "llama-b9874-bin-win-cpu-x64.zip",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b9874/llama-b9874-bin-win-cpu-x64.zip",
            sha256: "afeb33e219b54f5babddf31f31181ffa220a1c60600719d33633e78834393133",
        })
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        Ok(RuntimeAsset {
            name: "llama-b9874-bin-win-cpu-arm64.zip",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b9874/llama-b9874-bin-win-cpu-arm64.zip",
            sha256: "ec2274d05750e50797159e95ccde1e1c38c0dbad484d3aed8f59ef6098f7b54c",
        })
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Ok(RuntimeAsset {
            name: "llama-b9874-bin-ubuntu-x64.tar.gz",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b9874/llama-b9874-bin-ubuntu-x64.tar.gz",
            sha256: "5a3304b45428c12e8a81709b741d3770fa10d333d663c3c8039456fa9dd447bd",
        })
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        Ok(RuntimeAsset {
            name: "llama-b9874-bin-ubuntu-arm64.tar.gz",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b9874/llama-b9874-bin-ubuntu-arm64.tar.gz",
            sha256: "33ad52ddaac26ffc965d41a4a485346ad57aa1a08c22916a47637dc273f007ec",
        })
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    {
        Err("No prebuilt cleanup runtime is available for this platform yet.".into())
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Verbatim-AI (+https://github.com/GitHubCJ123/Verbatim-AI)")
        .build()
        .map_err(|e| e.to_string())
}

/// Serializes downloads per key so two clicks never write the same file.
fn download_lock(key: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<StdMutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadEvent {
    id: String,
    stage: &'static str,
    downloaded: u64,
    total: u64,
}

async fn install_runtime(app: &AppHandle, model_id: &str) -> Result<(), String> {
    let lock = download_lock("runtime");
    let _guard = lock.lock().await;
    if locate_llama_server(app)?.is_some() {
        return Ok(());
    }
    let asset = runtime_asset()?;
    let dir = bin_dir(app)?;
    let tmp_path = dir.join(format!("{}.partial", asset.name));
    let id = model_id.to_string();
    let downloaded = download_with_progress(
        &http_client()?,
        asset.url,
        &tmp_path,
        Duration::from_millis(150),
        |p: RuntimeAssetProgress| {
            let _ = app.emit(
                "cleanup:download:progress",
                DownloadEvent { id: id.clone(), stage: "runtime", downloaded: p.downloaded, total: p.total },
            );
        },
        |e| e.to_string(),
        |status, url| format!("download failed: HTTP {status} from {url}"),
    )
    .await;
    if let Err(e) = downloaded {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(e);
    }
    if let Err(e) = verify_sha256(&tmp_path, asset.sha256) {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(format!("Cleanup runtime checksum mismatch: {e}"));
    }
    let kind = ArchiveKind::from_file_name(asset.name)
        .ok_or_else(|| format!("Unsupported runtime archive: {}", asset.name))?;
    let archive = tmp_path.clone();
    let extracted = tauri::async_runtime::spawn_blocking(move || extract_atomically(&archive, &dir, kind))
        .await
        .map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&tmp_path).await;
    extracted?;
    if locate_llama_server(app)?.is_none() {
        return Err(format!("{} was not found in the runtime archive", llama_server_name()));
    }
    Ok(())
}

/// Extracts into a staging dir and moves entries in only on success, so a
/// failed extraction never leaves a half-installed runtime that looks valid.
fn extract_atomically(archive: &Path, dir: &Path, kind: ArchiveKind) -> Result<(), String> {
    let staging = dir.join(".staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        extract_archive(archive, &staging, kind)?;
        make_executables(&staging, &["llama-server"]);
        strip_quarantine(&staging);
        if locate_executable(&staging, llama_server_name()).is_none() {
            return Err(format!("{} was not found in the runtime archive", llama_server_name()));
        }
        for entry in std::fs::read_dir(&staging).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let target = dir.join(entry.file_name());
            if target.is_dir() {
                let _ = std::fs::remove_dir_all(&target);
            } else if target.exists() {
                let _ = std::fs::remove_file(&target);
            }
            std::fs::rename(entry.path(), &target).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupModelStatus {
    id: &'static str,
    installed: bool,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupEngineStatus {
    runtime_installed: bool,
    models: Vec<CleanupModelStatus>,
}

#[tauri::command]
pub async fn cleanup_engine_status(app: AppHandle) -> Result<CleanupEngineStatus, String> {
    let models = CLEANUP_MODELS
        .iter()
        .map(|m| {
            Ok(CleanupModelStatus {
                id: m.id,
                installed: model_path(&app, m)?.is_file(),
                size_bytes: m.size,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(CleanupEngineStatus {
        runtime_installed: locate_llama_server(&app)?.is_some(),
        models,
    })
}

/// Installs the runtime if needed, then downloads and verifies the model.
#[tauri::command]
pub async fn download_cleanup_model(app: AppHandle, id: String) -> Result<(), String> {
    let model = model_by_id(&id)?;
    install_runtime(&app, model.id).await?;

    let lock = download_lock(model.id);
    let _guard = lock.lock().await;
    let dest = model_path(&app, model)?;
    if dest.is_file() {
        let _ = app.emit("cleanup:download:complete", model.id);
        return Ok(());
    }
    let tmp_path = dest.with_extension("gguf.partial");
    let downloaded = download_with_progress(
        &http_client()?,
        model.url,
        &tmp_path,
        Duration::from_millis(150),
        |p: RuntimeAssetProgress| {
            let _ = app.emit(
                "cleanup:download:progress",
                DownloadEvent {
                    id: model.id.to_string(),
                    stage: "model",
                    downloaded: p.downloaded,
                    total: if p.total > 0 { p.total } else { model.size },
                },
            );
        },
        |e| e.to_string(),
        |status, url| format!("download failed: HTTP {status} from {url}"),
    )
    .await;
    if let Err(e) = downloaded {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(e);
    }
    let verify_path = tmp_path.clone();
    let expected = model.sha256;
    let verified = tauri::async_runtime::spawn_blocking(move || verify_sha256(&verify_path, expected))
        .await
        .map_err(|e| e.to_string())?;
    if let Err(e) = verified {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(format!("Model checksum mismatch for {}: {e}", model.id));
    }
    fs::rename(&tmp_path, &dest).await.map_err(|e| e.to_string())?;
    let _ = app.emit("cleanup:download:complete", model.id);
    Ok(())
}

#[tauri::command]
pub async fn delete_cleanup_model(
    app: AppHandle,
    state: State<'_, CleanupServerState>,
    id: String,
) -> Result<(), String> {
    let model = model_by_id(&id)?;
    // Waits for an in-flight download so it can't recreate the file afterwards.
    let lock = download_lock(model.id);
    let _guard = lock.lock().await;
    state.unload_if(model.id).await;
    let path = model_path(&app, model)?;
    if path.is_file() {
        fs::remove_file(&path).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

struct ServerHandle {
    child: Child,
    model_id: &'static str,
    base_url: String,
    api_key: String,
    ready: bool,
    last_used: Instant,
}

impl ServerHandle {
    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

#[derive(Clone)]
struct Endpoint {
    base_url: String,
    api_key: String,
}

/// The handle is stored as soon as the child spawns (before it is ready), so
/// unload and app shutdown can always reach it.
pub struct CleanupServerState {
    inner: Arc<Mutex<Option<ServerHandle>>>,
    starting: Arc<Mutex<()>>,
    idle: Duration,
}

impl Default for CleanupServerState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            starting: Arc::new(Mutex::new(())),
            idle: DEFAULT_IDLE,
        }
    }
}

impl CleanupServerState {
    async fn live_endpoint(&self, model_id: &str) -> Option<Endpoint> {
        let mut guard = self.inner.lock().await;
        let h = guard.as_mut()?;
        if h.ready && h.model_id == model_id && h.is_alive() {
            h.last_used = Instant::now();
            return Some(Endpoint { base_url: h.base_url.clone(), api_key: h.api_key.clone() });
        }
        None
    }

    async fn ensure(&self, app: &AppHandle, model: &'static CleanupModel) -> Result<Endpoint, String> {
        if let Some(ep) = self.live_endpoint(model.id).await {
            return Ok(ep);
        }
        let _starting = self.starting.lock().await;
        if let Some(ep) = self.live_endpoint(model.id).await {
            return Ok(ep);
        }
        let server = locate_llama_server(app)?
            .ok_or_else(|| "The AI polish engine isn't installed yet. Download a model in Settings → AI model.".to_string())?;
        let path = model_path(app, model)?;
        if !path.is_file() {
            return Err(format!("The {} cleanup model isn't downloaded yet.", model.id));
        }
        self.unload().await;

        let port = pick_free_port()?;
        let base_url = format!("http://127.0.0.1:{port}");
        let api_key = random_token()?;
        let mut cmd = Command::new(&server);
        cmd.arg("-m")
            .arg(&path)
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            .args(["-c", &CONTEXT_TOKENS.to_string(), "-np", "1", "--jinja", "--offline"])
            .args(["--no-webui", "--no-slots"])
            // Via the environment, not argv, so other local users can't read it from `ps`.
            .env("LLAMA_API_KEY", &api_key)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let child = cmd.spawn().map_err(|e| format!("Couldn't start the AI polish engine: {e}"))?;
        *self.inner.lock().await = Some(ServerHandle {
            child,
            model_id: model.id,
            base_url: base_url.clone(),
            api_key: api_key.clone(),
            ready: false,
            last_used: Instant::now(),
        });
        if let Err(e) = self.wait_until_ready(&base_url).await {
            self.unload().await;
            return Err(e);
        }
        Ok(Endpoint { base_url, api_key })
    }

    /// `/health` answers 503 while the model loads and 200 once it can serve.
    async fn wait_until_ready(&self, base_url: &str) -> Result<(), String> {
        let client = reqwest::Client::new();
        let deadline = Instant::now() + HEALTH_TIMEOUT;
        loop {
            {
                let mut guard = self.inner.lock().await;
                match guard.as_mut() {
                    Some(h) if h.base_url == base_url => {
                        if let Ok(Some(status)) = h.child.try_wait() {
                            return Err(format!("The AI polish engine exited during startup ({status})."));
                        }
                    }
                    _ => return Err("The AI polish engine was stopped while starting.".into()),
                }
            }
            let ready = client
                .get(format!("{base_url}/health"))
                .timeout(Duration::from_millis(800))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success());
            if ready {
                if let Some(h) = self.inner.lock().await.as_mut().filter(|h| h.base_url == base_url) {
                    h.ready = true;
                    h.last_used = Instant::now();
                    return Ok(());
                }
                return Err("The AI polish engine was stopped while starting.".into());
            }
            if Instant::now() >= deadline {
                return Err("The AI polish engine didn't become ready in time.".into());
            }
            tokio::time::sleep(HEALTH_POLL).await;
        }
    }

    async fn unload_if(&self, model_id: &str) {
        let mut guard = self.inner.lock().await;
        if guard.as_ref().is_some_and(|h| h.model_id == model_id) {
            if let Some(mut h) = guard.take() {
                let _ = h.child.start_kill();
            }
        }
    }

    async fn unload(&self) {
        if let Some(mut h) = self.inner.lock().await.take() {
            let _ = h.child.start_kill();
        }
    }

    /// Called from the exit handler (no async runtime). The lock is only ever
    /// held briefly, so retry instead of giving up on the first contention.
    fn terminate_now(&self) {
        for _ in 0..50 {
            if let Ok(mut guard) = self.inner.try_lock() {
                if let Some(mut h) = guard.take() {
                    let _ = h.child.start_kill();
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn spawn_idle_watcher(&self) {
        let inner = self.inner.clone();
        let idle = self.idle;
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(IDLE_CHECK).await;
                let mut guard = inner.lock().await;
                if guard.as_ref().is_some_and(|h| h.ready && h.last_used.elapsed() > idle) {
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
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("Couldn't generate an engine key: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[tauri::command]
pub async fn ensure_cleanup_ready(
    app: AppHandle,
    state: State<'_, CleanupServerState>,
    id: String,
) -> Result<(), String> {
    state.ensure(&app, model_by_id(&id)?).await.map(|_| ())
}

#[tauri::command]
pub async fn unload_cleanup_engine(state: State<'_, CleanupServerState>) -> Result<(), String> {
    state.unload().await;
    Ok(())
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupTextArgs {
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    temperature: Option<f32>,
}

fn completion_body(args: &CleanupTextArgs) -> serde_json::Value {
    serde_json::json!({
        "messages": args.messages,
        "max_tokens": args.max_tokens.clamp(16, 4096),
        "temperature": args.temperature.unwrap_or(0.2),
        "cache_prompt": true,
        "chat_template_kwargs": { "enable_thinking": false },
    })
}

fn completion_text(body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("Unreadable cleanup response: {e}"))?;
    if v.pointer("/choices/0/finish_reason").and_then(|r| r.as_str()) == Some("length") {
        return Err("the reply was cut off before it finished".into());
    }
    v.pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "Cleanup response had no text.".to_string())
}

#[tauri::command]
pub async fn cleanup_text(
    app: AppHandle,
    state: State<'_, CleanupServerState>,
    args: CleanupTextArgs,
) -> Result<String, String> {
    if args.messages.is_empty() {
        return Err("Cleanup prompt is empty.".into());
    }
    let ep = state.ensure(&app, model_by_id(&args.model)?).await?;
    let body = serde_json::to_vec(&completion_body(&args)).map_err(|e| e.to_string())?;
    let resp = reqwest::Client::new()
        .post(format!("{}/v1/chat/completions", ep.base_url))
        .bearer_auth(&ep.api_key)
        .header("content-type", "application/json")
        .body(body)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Cleanup request failed: {e}"))?;
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "Cleanup engine returned {status}: {}",
            String::from_utf8_lossy(&bytes).chars().take(300).collect::<String>()
        ));
    }
    completion_text(&bytes)
}

pub fn init(app: &AppHandle) {
    if let Some(state) = app.try_state::<CleanupServerState>() {
        state.spawn_idle_watcher();
    }
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<CleanupServerState>() {
        state.terminate_now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_entries_are_pinned_and_unique() {
        let mut ids = std::collections::HashSet::new();
        for m in CLEANUP_MODELS {
            assert!(ids.insert(m.id), "duplicate id {}", m.id);
            assert_eq!(m.sha256.len(), 64);
            assert!(m.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(m.url.starts_with("https://huggingface.co/"));
            assert!(m.url.ends_with(m.file), "{} url/file mismatch", m.id);
            let rev = m.url.split("/resolve/").nth(1).unwrap().split('/').next().unwrap();
            assert_eq!(rev.len(), 40, "{} must pin a commit, not a branch", m.id);
            assert!(m.size > 0);
        }
    }

    #[test]
    fn unknown_model_is_rejected() {
        assert!(model_by_id("../../etc/passwd").is_err());
        assert!(model_by_id("qwen3.5-2b").is_ok());
    }

    #[test]
    fn body_disables_thinking_and_clamps_tokens() {
        let args = CleanupTextArgs {
            model: "qwen3.5-2b".into(),
            messages: vec![ChatMessage { role: "user".into(), content: "hi".into() }],
            max_tokens: 100_000,
            temperature: None,
        };
        let body = completion_body(&args);
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(body["cache_prompt"], true);
    }

    #[test]
    fn completion_text_extracts_and_trims() {
        let body = br#"{"choices":[{"message":{"role":"assistant","content":"  Hello.\n"}}]}"#;
        assert_eq!(completion_text(body).unwrap(), "Hello.");
        assert!(completion_text(br#"{"choices":[]}"#).is_err());
        assert!(completion_text(b"not json").is_err());
    }

    #[test]
    fn truncated_reply_is_an_error() {
        let body = br#"{"choices":[{"finish_reason":"length","message":{"content":"Half a sent"}}]}"#;
        assert!(completion_text(body).is_err());
        let ok = br#"{"choices":[{"finish_reason":"stop","message":{"content":"Done."}}]}"#;
        assert_eq!(completion_text(ok).unwrap(), "Done.");
    }

    #[test]
    fn tokens_are_distinct_hex() {
        let a = random_token().unwrap();
        let b = random_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
