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
    unique_tmp_stem, verify_sha256, ArchiveKind, DownloadProgress as RuntimeAssetProgress,
};
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Emitter, Manager, State,
};
use tokio::fs;
use tokio::process::Command;

const SHERPA_ONNX_VERSION: &str = "v1.13.2";

/// Speech models run by the sherpa-onnx sidecar. Despite the name this also
/// covers NVIDIA Canary, which uses the same runtime and server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParakeetVariant {
    V2English,
    V3Multilingual,
    Canary180mFlash,
}

/// Canary has no language detection; these are the languages it accepts.
const CANARY_LANGUAGES: [&str; 4] = ["en", "de", "es", "fr"];

impl ParakeetVariant {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "v2" => Some(Self::V2English),
            "v3" => Some(Self::V3Multilingual),
            "canary-180m-flash" => Some(Self::Canary180mFlash),
            _ => None,
        }
    }
    fn tag(&self) -> &'static str {
        match self {
            Self::V2English => "v2",
            Self::V3Multilingual => "v3",
            Self::Canary180mFlash => "canary-180m-flash",
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
            Self::Canary180mFlash => {
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2"
            }
        }
    }
    /// Digests published by GitHub for the release assets above.
    fn model_archive_sha256(&self) -> &'static str {
        match self {
            Self::V2English => "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
            Self::V3Multilingual => "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
            Self::Canary180mFlash => "7a38ed8b13f014ad632b09ff8d22e0c6f1359dd046af9235d281dfae841b9ab9",
        }
    }
    fn model_files(&self) -> &'static [&'static str] {
        match self {
            Self::Canary180mFlash => &["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"],
            _ => &["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
        }
    }
    /// Model flags shared by the CLI and the websocket server.
    fn model_args(&self, dir: &Path, language: Option<&str>) -> Vec<String> {
        let path = |f: &str| dir.join(f).display().to_string();
        match self {
            Self::Canary180mFlash => {
                let lang = canary_language(language);
                vec![
                    format!("--canary-encoder={}", path("encoder.int8.onnx")),
                    format!("--canary-decoder={}", path("decoder.int8.onnx")),
                    format!("--tokens={}", path("tokens.txt")),
                    format!("--canary-src-lang={lang}"),
                    format!("--canary-tgt-lang={lang}"),
                    "--canary-use-pnc=true".to_string(),
                ]
            }
            _ => vec![
                format!("--encoder={}", path("encoder.int8.onnx")),
                format!("--decoder={}", path("decoder.int8.onnx")),
                format!("--joiner={}", path("joiner.int8.onnx")),
                format!("--tokens={}", path("tokens.txt")),
                "--model-type=nemo_transducer".to_string(),
            ],
        }
    }
    /// Server cache key: Canary's language is baked into the launch flags.
    fn server_key(&self, language: Option<&str>) -> String {
        match self {
            Self::Canary180mFlash => format!("{}:{}", self.tag(), canary_language(language)),
            _ => self.tag().to_string(),
        }
    }
    fn all() -> [Self; 3] {
        [Self::V2English, Self::V3Multilingual, Self::Canary180mFlash]
    }
}

/// The requested language if Canary supports it, else English.
fn canary_language(language: Option<&str>) -> &'static str {
    let code = language.map(|l| l.trim().to_ascii_lowercase());
    // Match the language subtag exactly ("es-ES" -> "es"), not a prefix.
    let subtag = code.as_deref().and_then(|c| c.split(['-', '_']).next());
    CANARY_LANGUAGES
        .into_iter()
        .find(|l| subtag == Some(*l))
        .unwrap_or("en")
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
        for f in v.model_files() {
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
    for f in v.model_files() {
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
    if v.model_files().iter().all(|f| dir.join(f).exists()) {
        let _ = app.emit("parakeet:download:complete", v.tag());
        return Ok(());
    }

    // Two downloads of one model would share the same partial/staging paths.
    let _in_flight = DownloadGuard::claim(v.tag())?;

    let url = v.model_archive_url();
    let tmp_archive = dir.join("parakeet-model.partial.tar.bz2");
    if let Err(e) = stream_download(&app, url, &tmp_archive, "parakeet:download:progress").await {
        let _ = fs::remove_file(&tmp_archive).await;
        return Err(e);
    }
    let verify_path = tmp_archive.clone();
    let expected = v.model_archive_sha256();
    let verified = tauri::async_runtime::spawn_blocking(move || verify_sha256(&verify_path, expected))
        .await
        .map_err(|e| e.to_string())?;
    if let Err(e) = verified {
        let _ = fs::remove_file(&tmp_archive).await;
        return Err(format!("Speech model checksum mismatch for {}: {e}", v.tag()));
    }

    // The archive top-level dir is `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/`.
    // Extract into a staging dir then flatten the needed files into `models_dir`.
    let staging = dir.join(".staging");
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let staging_for_extract = staging.clone();
    let tmp_for_extract = tmp_archive.clone();
    let extracted = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        extract_archive(&tmp_for_extract, &staging_for_extract, ArchiveKind::TarBz2)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r)
    .and_then(|()| move_model_files(v, &staging, &dir));

    // Success or failure, don't leave the archive or staging dir behind.
    let _ = std::fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&tmp_archive).await;
    extracted?;
    let _ = app.emit("parakeet:download:complete", v.tag());
    Ok(())
}

/// Moves each required file from the extracted archive up into `dir`.
fn move_model_files(v: ParakeetVariant, staging: &Path, dir: &Path) -> Result<(), String> {
    // Find every file before moving any, so a bad archive installs nothing.
    let mut sources = Vec::new();
    for &fname in v.model_files() {
        let src = locate_executable(staging, fname)
            .ok_or_else(|| format!("'{}' missing from archive", fname))?;
        sources.push((src, dir.join(fname)));
    }
    for (src, dst) in sources {
        if dst.exists() {
            let _ = std::fs::remove_file(&dst);
        }
        std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Rejects a second concurrent download of the same model.
struct DownloadGuard(&'static str);

impl DownloadGuard {
    fn active() -> &'static std::sync::Mutex<std::collections::HashSet<&'static str>> {
        static ACTIVE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<&'static str>>> =
            std::sync::OnceLock::new();
        ACTIVE.get_or_init(Default::default)
    }

    fn claim(tag: &'static str) -> Result<Self, String> {
        let inserted = Self::active().lock().unwrap_or_else(|e| e.into_inner()).insert(tag);
        if inserted {
            Ok(Self(tag))
        } else {
            Err(format!("The {tag} model is already downloading."))
        }
    }
}

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        Self::active().lock().unwrap_or_else(|e| e.into_inner()).remove(self.0);
    }
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
    for f in v.model_files() {
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
    /// Variant tag: "v2", "v3" or "canary-180m-flash".
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
    for fname in v.model_files() {
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
    language: Option<&str>,
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
        model_args: v.model_args(dir, language),
        log_file: log_dir.join("parakeet-server.log"),
        key: v.server_key(language),
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
    language: Option<String>,
) -> Result<(), String> {
    let v = parse_variant(&variant)?;
    let dir = installed_model_dir(&app, v)?;
    if locate_cli(&app)?.is_none() {
        return Err("sherpa-onnx runtime is not installed.".into());
    }
    let language = language.filter(|l| l != "auto");
    match server_launch(&app, v, &dir, language.as_deref())? {
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
    match server_launch(app, v, &dir, language_hint(&language_detected)) {
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

    let text = run_cli(app, &cli, v, &dir, language_hint(&language_detected), &pcm).await?;
    Ok(TranscribeOutput {
        text,
        language_detected,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

fn language_hint(language: &str) -> Option<&str> {
    (language != "auto").then_some(language)
}

async fn run_cli(
    app: &AppHandle,
    cli: &Path,
    v: ParakeetVariant,
    dir: &Path,
    language: Option<&str>,
    pcm: &[f32],
) -> Result<String, String> {
    let tmp_dir = app_data(app)?.join("parakeet-tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let wav_path = tmp_dir.join(format!("{}.wav", unique_tmp_stem("rec")));
    std::fs::write(&wav_path, encode_wav_pcm16(pcm, 16_000)).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(cli);
    cmd.args(v.model_args(dir, language));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variant_tags_round_trip() {
        for v in ParakeetVariant::all() {
            assert_eq!(ParakeetVariant::from_str(v.tag()), Some(v));
        }
        assert_eq!(ParakeetVariant::from_str("../v3"), None);
    }

    #[test]
    fn canary_language_falls_back_to_english() {
        assert_eq!(canary_language(Some("fr")), "fr");
        assert_eq!(canary_language(Some("es-ES")), "es");
        assert_eq!(canary_language(Some("pt_BR")), "en");
        assert_eq!(canary_language(Some("est")), "en");
        assert_eq!(canary_language(Some("fro")), "en");
        assert_eq!(canary_language(Some("--canary-tgt-lang=de")), "en");
        assert_eq!(canary_language(Some("ja")), "en");
        assert_eq!(canary_language(None), "en");
    }

    #[test]
    fn canary_launch_args_and_key_carry_the_language() {
        let v = ParakeetVariant::Canary180mFlash;
        let args = v.model_args(Path::new("/m"), Some("de"));
        assert!(args.contains(&"--canary-src-lang=de".to_string()));
        assert!(args.contains(&"--canary-tgt-lang=de".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("--joiner")));
        assert_eq!(v.server_key(Some("de")), "canary-180m-flash:de");
        assert_eq!(v.model_files().len(), 3);
    }

    #[test]
    fn parakeet_launch_args_are_unchanged() {
        let args = ParakeetVariant::V3Multilingual.model_args(Path::new("/m"), Some("de"));
        assert!(args.contains(&"--model-type=nemo_transducer".to_string()));
        assert_eq!(ParakeetVariant::V3Multilingual.server_key(Some("de")), "v3");
    }

    /// Real Canary round trip through the resident server. Run with
    /// `VERBATIM_PARAKEET_SERVER=<bin> VERBATIM_CANARY_MODEL_DIR=<dir>
    /// VERBATIM_CANARY_WAV=<16k mono wav> cargo test canary_server -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "needs a sherpa-onnx runtime + Canary model on disk"]
    async fn canary_server_round_trip() {
        let (Ok(bin), Ok(dir), Ok(wav)) = (
            std::env::var("VERBATIM_PARAKEET_SERVER"),
            std::env::var("VERBATIM_CANARY_MODEL_DIR"),
            std::env::var("VERBATIM_CANARY_WAV"),
        ) else {
            return;
        };
        let v = ParakeetVariant::Canary180mFlash;
        let state = ParakeetServerState::default();
        let launch = ParakeetServerLaunch {
            server_bin: bin.into(),
            model_args: v.model_args(Path::new(&dir), Some("en")),
            log_file: std::env::temp_dir().join("verbatim-canary-test.log"),
            key: v.server_key(Some("en")),
            threads: inference_threads(),
        };
        let port = state.ensure_launch(launch).await.unwrap();
        let bytes = std::fs::read(wav).unwrap();
        let pcm: Vec<f32> = bytes[44..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect();
        let started = Instant::now();
        let text = recognize(port, &pcm, request_timeout(pcm.len())).await.unwrap();
        eprintln!("canary warm request {} ms -> {text}", started.elapsed().as_millis());
        assert!(!text.is_empty());
        state.unload().await;
    }

    #[test]
    fn a_second_download_of_the_same_model_is_rejected_until_the_first_ends() {
        let first = DownloadGuard::claim("canary-180m-flash").unwrap();
        assert!(DownloadGuard::claim("canary-180m-flash").is_err());
        assert!(DownloadGuard::claim("v3").is_ok());
        drop(first);
        assert!(DownloadGuard::claim("canary-180m-flash").is_ok());
    }

    #[test]
    fn missing_archive_files_are_reported_and_nothing_is_left_half_moved() {
        let root = std::env::temp_dir().join(format!("verbatim-move-test-{}", std::process::id()));
        let staging = root.join("staging");
        let dir = root.join("models");
        std::fs::create_dir_all(staging.join("bundle")).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(staging.join("bundle/encoder.int8.onnx"), b"e").unwrap();
        std::fs::write(staging.join("bundle/tokens.txt"), b"t").unwrap();
        let err = move_model_files(ParakeetVariant::Canary180mFlash, &staging, &dir).unwrap_err();
        assert!(err.contains("decoder.int8.onnx"), "{err}");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "nothing may be moved");
        std::fs::write(staging.join("bundle/decoder.int8.onnx"), b"d").unwrap();
        move_model_files(ParakeetVariant::Canary180mFlash, &staging, &dir).unwrap();
        assert!(dir.join("decoder.int8.onnx").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn archives_have_pinned_digests() {
        for v in ParakeetVariant::all() {
            let d = v.model_archive_sha256();
            assert_eq!(d.len(), 64);
            assert!(d.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }
}
