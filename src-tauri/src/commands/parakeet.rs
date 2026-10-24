//! Parakeet TDT v3 transcription via the sherpa-onnx CPU sidecar.
//!
//! Mirrors `local_whisper.rs`: we download the prebuilt sherpa-onnx runtime
//! plus a Parakeet ONNX model bundle into the app data dir. Transcription runs
//! on the resident `sherpa-onnx-offline-websocket-server` (see
//! `parakeet_server.rs`) and falls back to the one-shot `sherpa-onnx-offline`
//! CLI. CPU-only — no CUDA/CoreML providers in this build.
//!
//! Layout under `app_data_dir`:
//!   parakeet-bin/sherpa-onnx-offline(.exe)   (+ websocket server, DLLs/dylibs)
//!   parakeet-models/v3/encoder.int8.onnx
//!   parakeet-models/v3/decoder.int8.onnx
//!   parakeet-models/v3/joiner.int8.onnx
//!   parakeet-models/v3/tokens.txt

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::parakeet_server::{recognize, request_timeout, ParakeetServerLaunch, ParakeetServerState};
use super::runtime_assets::{
    clear_dir_contents, download_with_progress, encode_wav_pcm16, extract_archive,
    inference_threads, locate_executable, make_executables, pcm_from_le_bytes, strip_quarantine,
    unique_tmp_stem, ArchiveKind, DownloadProgress as RuntimeAssetProgress,
};
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Emitter, Manager, State,
};
use tokio::fs;
use tokio::process::Command;

const SHERPA_ONNX_VERSION: &str = "v1.13.2";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParakeetVariant {
    V2English,
    V3Multilingual,
}

impl ParakeetVariant {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "v2" => Some(Self::V2English),
            "v3" => Some(Self::V3Multilingual),
            _ => None,
        }
    }
    fn tag(&self) -> &'static str {
        match self {
            Self::V2English => "v2",
            Self::V3Multilingual => "v3",
        }
    }
    fn model_archive_url(&self) -> &'static str {
        match self {
            Self::V2English => {
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2"
            }
            Self::V3Multilingual => {
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2"
            }
        }
    }
    fn all() -> [Self; 2] {
        [Self::V2English, Self::V3Multilingual]
    }
}

fn parse_variant(s: &str) -> Result<ParakeetVariant, String> {
    ParakeetVariant::from_str(s).ok_or_else(|| format!("unknown parakeet variant: {s}"))
}

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data(app)?.join("parakeet-bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn models_dir(app: &AppHandle, variant: ParakeetVariant) -> Result<PathBuf, String> {
    let dir = app_data(app)?.join("parakeet-models").join(variant.tag());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn cli_name() -> &'static str {
    #[cfg(windows)]
    {
        "sherpa-onnx-offline.exe"
    }
    #[cfg(not(windows))]
    {
        "sherpa-onnx-offline"
    }
}

fn locate_cli(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let dir = bin_dir(app)?;
    Ok(locate_executable(&dir, cli_name()))
}


fn runtime_archive_url() -> Result<&'static str, String> {
    // Pinned to a tested sherpa-onnx version. Bump deliberately after
    // verifying the CLI flags + JSON output haven't changed.
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        Ok("https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-v1.13.2-win-x64-shared-MD-Release.tar.bz2")
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Ok("https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-v1.13.2-osx-arm64-shared.tar.bz2")
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
    )))]
    {
        Err("Parakeet is only available on Windows x64 and macOS (Apple Silicon).".into())
    }
}



#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    total: u64,
}

async fn stream_download(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    progress_event: &str,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("Verbatim-AI/0.4 (+https://github.com/GitHubCJ123/Verbatim-AI)")
        .build()
        .map_err(|e| e.to_string())?;
    let result = download_with_progress(
        &client,
        url,
        dest,
        Duration::from_millis(200),
        |progress: RuntimeAssetProgress| {
            let _ = app.emit(
                progress_event,
                Progress {
                    downloaded: progress.downloaded,
                    total: progress.total,
                },
            );
        },
        |e| e.to_string(),
        |status, url| format!("download failed: HTTP {status} from {url}"),
    )
    .await?;
    let _ = app.emit(
        progress_event,
        Progress {
            downloaded: result.total.max(result.downloaded),
            total: result.total.max(result.downloaded),
        },
    );
    Ok(())
}



#[tauri::command]
pub async fn is_parakeet_runtime_installed(app: AppHandle) -> Result<bool, String> {
    Ok(locate_cli(&app)?.is_some())
}

#[tauri::command]
pub async fn install_parakeet_runtime(
    app: AppHandle,
    state: State<'_, ParakeetServerState>,
) -> Result<(), String> {
    let url = runtime_archive_url()?;
    let dir = bin_dir(&app)?;
    // The resident server runs out of this directory (and locks it on Windows).
    state.unload().await;

    // Wipe any previous extraction so we pick up version changes.
    clear_dir_contents(&dir)?;
    let tmp_archive = dir.join("parakeet-runtime.partial.tar.bz2");
    stream_download(&app, url, &tmp_archive, "parakeet:runtime:progress").await?;

    let extract_dir = dir.clone();
    let tmp_for_extract = tmp_archive.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        extract_archive(&tmp_for_extract, &extract_dir, ArchiveKind::TarBz2)?;
        make_executables(&extract_dir, &["sherpa-onnx-offline", server_name()]);
        strip_quarantine(&extract_dir);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    let _ = fs::remove_file(&tmp_archive).await;

    if locate_cli(&app)?.is_none() {
        return Err(format!(
            "Extraction finished but {} was not found in the archive",
            cli_name()
        ));
    }
    let _ = app.emit("parakeet:runtime:complete", SHERPA_ONNX_VERSION);
    Ok(())
}

fn model_files() -> [&'static str; 4] {
    [
        "encoder.int8.onnx",
        "decoder.int8.onnx",
        "joiner.int8.onnx",
        "tokens.txt",
    ]
}

#[derive(Serialize)]
pub struct ParakeetModelInfo {
    variant: String,
    installed: bool,
    size_bytes: u64,
}

#[tauri::command]
pub async fn list_parakeet_models(app: AppHandle) -> Result<Vec<ParakeetModelInfo>, String> {
    let mut out = Vec::new();
    for v in ParakeetVariant::all() {
        let dir = models_dir(&app, v)?;
        let mut total: u64 = 0;
        let mut all_present = true;
        for f in model_files() {
            match std::fs::metadata(dir.join(f)) {
                Ok(m) => total += m.len(),
                Err(_) => {
                    all_present = false;
                    break;
                }
            }
        }
        out.push(ParakeetModelInfo {
            variant: v.tag().to_string(),
            installed: all_present,
            size_bytes: if all_present { total } else { 0 },
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn is_parakeet_model_installed(
    app: AppHandle,
    variant: String,
) -> Result<ParakeetModelInfo, String> {
    let v = parse_variant(&variant)?;
    let dir = models_dir(&app, v)?;
    let mut total: u64 = 0;
    let mut all_present = true;
    for f in model_files() {
        match std::fs::metadata(dir.join(f)) {
            Ok(m) => total += m.len(),
            Err(_) => {
                all_present = false;
                break;
            }
        }
    }
    Ok(ParakeetModelInfo {
        variant: v.tag().to_string(),
        installed: all_present,
        size_bytes: if all_present { total } else { 0 },
    })
}

#[tauri::command]
pub async fn download_parakeet_model(app: AppHandle, variant: String) -> Result<(), String> {
    let v = parse_variant(&variant)?;
    let dir = models_dir(&app, v)?;
    // If already complete, emit and return.
    if model_files().iter().all(|f| dir.join(f).exists()) {
        let _ = app.emit("parakeet:download:complete", v.tag());
        return Ok(());
    }

    let url = v.model_archive_url();
    let tmp_archive = dir.join("parakeet-model.partial.tar.bz2");
    stream_download(&app, url, &tmp_archive, "parakeet:download:progress").await?;

    // The archive top-level dir is `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/`.
    // Extract into a staging dir then flatten the needed files into `models_dir`.
    let staging = dir.join(".staging");
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let staging_for_extract = staging.clone();
    let tmp_for_extract = tmp_archive.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        extract_archive(&tmp_for_extract, &staging_for_extract, ArchiveKind::TarBz2)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Find each required file under staging and move it up into models_dir.
    for fname in model_files() {
        let src =
            locate_executable(&staging, fname).ok_or_else(|| format!("'{}' missing from archive", fname))?;
        let dst = dir.join(fname);
        if dst.exists() {
            let _ = std::fs::remove_file(&dst);
        }
        std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    }

    let _ = std::fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&tmp_archive).await;
    let _ = app.emit("parakeet:download:complete", v.tag());
    Ok(())
}

#[tauri::command]
pub async fn delete_parakeet_model(
    app: AppHandle,
    state: State<'_, ParakeetServerState>,
    variant: String,
) -> Result<(), String> {
    let v = parse_variant(&variant)?;
    // Release the model files the resident server holds open.
    state.unload().await;
    let dir = models_dir(&app, v)?;
    for f in model_files() {
        let p = dir.join(f);
        if p.exists() {
            let _ = std::fs::remove_file(&p);
        }
    }
    Ok(())
}

// --------------------------------------------------------------------------
// Transcription
// --------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct TranscribeArgs {
    /// Variant tag: "v2" or "v3".
    pub variant: String,
    /// 16 kHz mono Float32 PCM samples.
    pub pcm: Vec<f32>,
    /// Reserved for future use; model auto-detects language.
    pub language: Option<String>,
}

#[derive(Serialize)]
pub struct TranscribeOutput {
    text: String,
    language_detected: String,
    duration_ms: u64,
}

fn server_name() -> &'static str {
    #[cfg(windows)]
    {
        "sherpa-onnx-offline-websocket-server.exe"
    }
    #[cfg(not(windows))]
    {
        "sherpa-onnx-offline-websocket-server"
    }
}

/// Model dir for `v` with every required file present, or a user-facing error.
fn installed_model_dir(app: &AppHandle, v: ParakeetVariant) -> Result<PathBuf, String> {
    let dir = models_dir(app, v)?;
    for fname in model_files() {
        if !dir.join(fname).exists() {
            return Err(format!(
                "Parakeet {} model file '{}' is missing. Download it from Settings → AI model.",
                v.tag(),
                fname
            ));
        }
    }
    Ok(dir)
}

/// Launch spec for the resident websocket server, or `None` when this runtime
/// install doesn't include it (we then use the one-shot CLI).
fn server_launch(
    app: &AppHandle,
    v: ParakeetVariant,
    dir: &Path,
) -> Result<Option<ParakeetServerLaunch>, String> {
    let bin_root = bin_dir(app)?;
    let Some(server_bin) = locate_executable(&bin_root, server_name()) else {
        return Ok(None);
    };
    // Runtimes installed before the server was used only had the CLI marked
    // executable (tar extraction doesn't keep modes); fix that up lazily.
    make_executables(&bin_root, &[server_name()]);
    let log_dir = app_data(app)?.join("parakeet-tmp");
    std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    Ok(Some(ParakeetServerLaunch {
        server_bin,
        encoder: dir.join("encoder.int8.onnx"),
        decoder: dir.join("decoder.int8.onnx"),
        joiner: dir.join("joiner.int8.onnx"),
        tokens: dir.join("tokens.txt"),
        log_file: log_dir.join("parakeet-server.log"),
        key: v.tag().to_string(),
        threads: inference_threads(),
    }))
}

/// Load the model into the resident server ahead of time (hotkey press /
/// app start) so the first transcription doesn't pay the multi-second load.
#[tauri::command]
pub async fn ensure_parakeet_ready(
    app: AppHandle,
    state: State<'_, ParakeetServerState>,
    variant: String,
) -> Result<(), String> {
    let v = parse_variant(&variant)?;
    let dir = installed_model_dir(&app, v)?;
    if locate_cli(&app)?.is_none() {
        return Err("sherpa-onnx runtime is not installed.".into());
    }
    match server_launch(&app, v, &dir)? {
        Some(launch) => state.ensure_launch(launch).await.map(|_| ()),
        None => Ok(()),
    }
}

/// Raw-PCM transcription: the body is little-endian f32 16 kHz mono samples
/// (no JSON number array), with the variant/language in headers.
#[tauri::command]
pub async fn transcribe_parakeet_pcm(
    app: AppHandle,
    state: State<'_, ParakeetServerState>,
    request: Request<'_>,
) -> Result<TranscribeOutput, String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(ToOwned::to_owned)
    };
    if header("x-verbatim-pcm-format").as_deref() != Some("f32le-16000-mono") {
        return Err("Unsupported or missing PCM format header".into());
    }
    let pcm = match request.body() {
        InvokeBody::Raw(bytes) => pcm_from_le_bytes(bytes)?,
        InvokeBody::Json(_) => return Err("PCM audio must be sent as raw bytes".into()),
    };
    let variant = header("x-verbatim-parakeet-variant").unwrap_or_else(|| "v3".into());
    let language = header("x-verbatim-language").filter(|l| l != "auto");
    transcribe_impl(&app, &state, &variant, pcm, language).await
}

#[tauri::command]
pub async fn transcribe_parakeet(
    app: AppHandle,
    state: State<'_, ParakeetServerState>,
    args: TranscribeArgs,
) -> Result<TranscribeOutput, String> {
    transcribe_impl(&app, &state, &args.variant, args.pcm, args.language).await
}

async fn transcribe_impl(
    app: &AppHandle,
    state: &ParakeetServerState,
    variant: &str,
    pcm: Vec<f32>,
    language: Option<String>,
) -> Result<TranscribeOutput, String> {
    let v = parse_variant(variant)?;
    let dir = installed_model_dir(app, v)?;
    let cli = locate_cli(app)?.ok_or_else(|| {
        "sherpa-onnx runtime is not installed. Click 'Install runtime' in Settings → AI model."
            .to_string()
    })?;
    if pcm.is_empty() {
        return Err("Empty audio buffer".into());
    }
    let language_detected = language.unwrap_or_else(|| "auto".into());
    let started = Instant::now();

    // Fast path: the warm resident server. Any failure (missing binary,
    // startup error, crash mid-request, timeout) falls back to the one-shot
    // CLI for this utterance, so a server problem costs latency, not the
    // dictation. The next request respawns the server.
    match server_launch(app, v, &dir) {
        Ok(Some(launch)) => match state.ensure_launch(launch).await {
            Ok(port) => match recognize(port, &pcm, request_timeout(pcm.len())).await {
                Ok(text) => {
                    return Ok(TranscribeOutput {
                        text,
                        language_detected,
                        duration_ms: started.elapsed().as_millis() as u64,
                    })
                }
                Err(e) => {
                    eprintln!("[parakeet] warm server request failed, using CLI: {e}");
                    state.unload().await;
                }
            },
            Err(e) => eprintln!("[parakeet] warm server unavailable, using CLI: {e}"),
        },
        Ok(None) => {}
        Err(e) => eprintln!("[parakeet] warm server launch failed, using CLI: {e}"),
    }

    let text = run_cli(app, &cli, &dir, &pcm).await?;
    Ok(TranscribeOutput {
        text,
        language_detected,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

async fn run_cli(app: &AppHandle, cli: &Path, dir: &Path, pcm: &[f32]) -> Result<String, String> {
    let tmp_dir = app_data(app)?.join("parakeet-tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let wav_path = tmp_dir.join(format!("{}.wav", unique_tmp_stem("rec")));
    std::fs::write(&wav_path, encode_wav_pcm16(pcm, 16_000)).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(cli);
    cmd.arg(format!("--encoder={}", dir.join("encoder.int8.onnx").display()));
    cmd.arg(format!("--decoder={}", dir.join("decoder.int8.onnx").display()));
    cmd.arg(format!("--joiner={}", dir.join("joiner.int8.onnx").display()));
    cmd.arg(format!("--tokens={}", dir.join("tokens.txt").display()));
    cmd.arg("--model-type=nemo_transducer");
    cmd.arg(format!("--num-threads={}", inference_threads()));
    cmd.arg(&wav_path);

    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output().await.map_err(|e| e.to_string());
    let _ = fs::remove_file(&wav_path).await;
    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "sherpa-onnx-offline failed (exit {:?}): {}",
            output.status.code(),
            stderr.trim()
        ));
    }

    // sherpa-onnx prints diagnostics + a JSON object on stdout.
    // Locate the last `{...}` block and parse it.
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(extract_transcript(&stdout).unwrap_or_else(|| stdout.trim().to_string()))
}

/// Parse sherpa-onnx stdout to extract the transcript `text` field.
/// The CLI prints driver logs followed by a JSON line per input file.
fn extract_transcript(stdout: &str) -> Option<String> {
    // Find a `{ ... "text": "..." ... }` block by scanning lines in reverse.
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') && trimmed.contains("\"text\"") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
                    return Some(t.trim().to_string());
                }
            }
        }
    }
    // Fallback: try parsing the whole stdout for a `{...}` substring.
    let start = stdout.find('{')?;
    let end = stdout.rfind('}')?;
    if end > start {
        let candidate = &stdout[start..=end];
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(candidate) {
            if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
                return Some(t.trim().to_string());
            }
        }
    }
    None
}
