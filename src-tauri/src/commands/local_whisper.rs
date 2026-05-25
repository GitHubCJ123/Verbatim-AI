//! Local Whisper transcription via whisper.cpp **sidecar binary**.
//!
//! We don't link whisper.cpp into our binary (that path hit bindgen/libclang
//! version-mismatch issues on Windows). Instead we download the official
//! prebuilt `whisper-cli` executable from the whisper.cpp GitHub releases,
//! drop it in the app data dir, and shell out per transcription.
//!
//! Layout under `app_data_dir`:
//!   whisper-bin/whisper-cli.exe   (+ supporting DLLs)
//!   whisper-models/ggml-*.bin

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const WHISPER_CPP_VERSION: &str = "v1.8.4";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhisperTier {
    Tiny,
    Base,
    Small,
    Turbo,
    LargeV3,
}

impl WhisperTier {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "tiny" => Some(Self::Tiny),
            "base" => Some(Self::Base),
            "small" => Some(Self::Small),
            "turbo" => Some(Self::Turbo),
            "large-v3" => Some(Self::LargeV3),
            _ => None,
        }
    }
    fn as_str(&self) -> &'static str {
        match self {
            Self::Tiny => "tiny",
            Self::Base => "base",
            Self::Small => "small",
            Self::Turbo => "turbo",
            Self::LargeV3 => "large-v3",
        }
    }
    fn file_name(&self) -> &'static str {
        match self {
            Self::Tiny => "ggml-tiny.bin",
            Self::Base => "ggml-base.bin",
            Self::Small => "ggml-small.bin",
            Self::Turbo => "ggml-large-v3-turbo-q5_0.bin",
            Self::LargeV3 => "ggml-large-v3.bin",
        }
    }
    fn download_url(&self) -> String {
        format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
            self.file_name()
        )
    }
    fn all() -> [Self; 5] {
        [
            Self::Tiny,
            Self::Base,
            Self::Small,
            Self::Turbo,
            Self::LargeV3,
        ]
    }
}

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data(app)?.join("whisper-models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data(app)?.join("whisper-bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn whisper_cli_name() -> &'static str {
    #[cfg(windows)]
    {
        "whisper-cli.exe"
    }
    #[cfg(not(windows))]
    {
        "whisper-cli"
    }
}

fn locate_whisper_cli(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let dir = bin_dir(app)?;
    let target = whisper_cli_name();
    fn walk(dir: &Path, target: &str) -> Option<PathBuf> {
        let entries = std::fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                if p.file_name().and_then(|n| n.to_str()) == Some(target) {
                    return Some(p);
                }
            } else if p.is_dir() {
                if let Some(found) = walk(&p, target) {
                    return Some(found);
                }
            }
        }
        None
    }
    Ok(walk(&dir, target))
}

fn runtime_archive_url() -> Result<&'static str, String> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        // CUDA-accelerated build. Bundles the cuBLAS/cuDART DLLs; runs on
        // any machine with a reasonably current NVIDIA driver. Falls back
        // to CPU if no CUDA device is present.
        Ok("https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-cublas-12.4.0-bin-x64.zip")
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        // Apple Silicon build with Metal acceleration. Built by
        // .github/workflows/build-whisper-macos.yml and published to
        // this repo's own releases. Run that workflow once per
        // whisper.cpp version bump.
        Ok("https://github.com/GitHubCJ123/Verbatim-AI/releases/download/whisper-runtime-v1.8.4/whisper-bin-macos-arm64.zip")
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
    )))]
    {
        Err("No prebuilt whisper.cpp runtime is available for this platform yet.".into())
    }
}

#[tauri::command]
pub async fn is_whisper_runtime_installed(app: AppHandle) -> Result<bool, String> {
    Ok(locate_whisper_cli(&app)?.is_some())
}

#[derive(Serialize, Clone)]
struct RuntimeProgress {
    downloaded: u64,
    total: u64,
}

#[tauri::command]
pub async fn install_whisper_runtime(app: AppHandle) -> Result<(), String> {
    let url = runtime_archive_url()?;
    let dir = bin_dir(&app)?;

    // Always reinstall fresh: wipe any previous extraction so we pick up
    // URL/version changes (e.g. CPU build -> CUDA build).
    if dir.exists() {
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            } else {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    let tmp_zip = dir.join("whisper-bin.partial.zip");

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("download failed: HTTP {}", res.status()));
    }
    let total = res.content_length().unwrap_or(0);

    let mut file = fs::File::create(&tmp_zip)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;
        if last_emit.elapsed().as_millis() > 150 {
            last_emit = Instant::now();
            let _ = app.emit(
                "local-whisper:runtime:progress",
                RuntimeProgress { downloaded, total },
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    let extract_dir = dir.clone();
    let tmp_zip_for_extract = tmp_zip.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let f = std::fs::File::open(&tmp_zip_for_extract).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let rel = match entry.enclosed_name() {
                Some(p) => p.to_owned(),
                None => continue,
            };
            let out_path = extract_dir.join(&rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    let _ = fs::remove_file(&tmp_zip).await;

    if locate_whisper_cli(&app)?.is_none() {
        return Err(format!(
            "Extraction finished but {} was not found in the archive",
            whisper_cli_name()
        ));
    }
    let _ = app.emit("local-whisper:runtime:complete", WHISPER_CPP_VERSION);
    Ok(())
}

#[derive(Serialize)]
pub struct ModelInfo {
    tier: &'static str,
    installed: bool,
    size_bytes: u64,
}

#[tauri::command]
pub async fn list_local_models(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let dir = models_dir(&app)?;
    let mut out = Vec::new();
    for t in WhisperTier::all() {
        let p = dir.join(t.file_name());
        let (installed, size_bytes) = match std::fs::metadata(&p) {
            Ok(m) => (true, m.len()),
            Err(_) => (false, 0),
        };
        out.push(ModelInfo {
            tier: t.as_str(),
            installed,
            size_bytes,
        });
    }
    Ok(out)
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    tier: String,
    downloaded: u64,
    total: u64,
}

#[tauri::command]
pub async fn download_local_model(app: AppHandle, tier: String) -> Result<(), String> {
    let t = WhisperTier::from_str(&tier).ok_or_else(|| format!("unknown tier: {tier}"))?;
    let dir = models_dir(&app)?;
    let final_path = dir.join(t.file_name());
    if final_path.exists() {
        let _ = app.emit("local-whisper:download:complete", t.as_str().to_string());
        return Ok(());
    }
    let tmp_path = dir.join(format!("{}.partial", t.file_name()));
    let url = t.download_url();

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("download failed: HTTP {}", res.status()));
    }
    let total = res.content_length().unwrap_or(0);

    let mut file = fs::File::create(&tmp_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;
        if last_emit.elapsed().as_millis() > 200 {
            last_emit = Instant::now();
            let _ = app.emit(
                "local-whisper:download:progress",
                DownloadProgress {
                    tier: t.as_str().to_string(),
                    downloaded,
                    total,
                },
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    fs::rename(&tmp_path, &final_path)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "local-whisper:download:progress",
        DownloadProgress {
            tier: t.as_str().to_string(),
            downloaded: total.max(downloaded),
            total: total.max(downloaded),
        },
    );
    let _ = app.emit("local-whisper:download:complete", t.as_str().to_string());
    Ok(())
}

#[tauri::command]
pub async fn delete_local_model(app: AppHandle, tier: String) -> Result<(), String> {
    let t = WhisperTier::from_str(&tier).ok_or_else(|| format!("unknown tier: {tier}"))?;
    let path = models_dir(&app)?.join(t.file_name());
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct TranscribeArgs {
    pub tier: String,
    pub language: Option<String>,
    pub translate: Option<bool>,
    /// 16 kHz mono Float32 PCM samples.
    pub pcm: Vec<f32>,
}

#[derive(Serialize)]
pub struct TranscribeOutput {
    text: String,
    language_detected: String,
    duration_ms: u64,
}

fn write_wav(path: &Path, samples: &[f32]) -> Result<(), String> {
    let sample_rate: u32 = 16000;
    let bits_per_sample: u16 = 16;
    let num_channels: u16 = 1;
    let byte_rate = sample_rate * (bits_per_sample as u32 / 8) * num_channels as u32;
    let block_align = num_channels * bits_per_sample / 8;
    let data_bytes = (samples.len() * 2) as u32;
    let chunk_size = 36 + data_bytes;

    let mut f = std::fs::File::create(path).map_err(|e| e.to_string())?;
    f.write_all(b"RIFF").map_err(|e| e.to_string())?;
    f.write_all(&chunk_size.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(b"WAVE").map_err(|e| e.to_string())?;
    f.write_all(b"fmt ").map_err(|e| e.to_string())?;
    f.write_all(&16u32.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&1u16.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&num_channels.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&sample_rate.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&byte_rate.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&block_align.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&bits_per_sample.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(b"data").map_err(|e| e.to_string())?;
    f.write_all(&data_bytes.to_le_bytes())
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        let v = (clamped * i16::MAX as f32) as i16;
        buf.extend_from_slice(&v.to_le_bytes());
    }
    f.write_all(&buf).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn transcribe_local(
    app: AppHandle,
    args: TranscribeArgs,
) -> Result<TranscribeOutput, String> {
    let t =
        WhisperTier::from_str(&args.tier).ok_or_else(|| format!("unknown tier: {}", args.tier))?;
    let model_path = models_dir(&app)?.join(t.file_name());
    if !model_path.exists() {
        return Err(format!(
            "Model '{}' is not downloaded yet. Download it from Settings → AI model.",
            args.tier
        ));
    }
    let cli_path = locate_whisper_cli(&app)?.ok_or_else(|| {
        "whisper.cpp runtime is not installed. Click 'Install runtime' in Settings → AI model."
            .to_string()
    })?;

    if args.pcm.is_empty() {
        return Err("Empty audio buffer".into());
    }

    let tmp_dir = app_data(&app)?.join("whisper-tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let wav_path = tmp_dir.join(format!(
        "rec-{}.wav",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    write_wav(&wav_path, &args.pcm)?;

    let started = Instant::now();

    let mut cmd = Command::new(&cli_path);
    cmd.arg("-m").arg(&model_path);
    cmd.arg("-f").arg(&wav_path);
    cmd.arg("-nt");
    // -np (no-prints) is intentionally omitted: we want to see model-load,
    // CUDA init, and timing lines on stderr for diagnostics. The actual
    // transcript still arrives clean on stdout (-nt strips timestamps).
    cmd.arg("-fa"); // flash attention — much faster on Ampere+ NVIDIA GPUs
    let lang = args.language.as_deref().unwrap_or("auto");
    cmd.arg("-l").arg(lang);
    if args.translate.unwrap_or(false) {
        cmd.arg("-tr");
    }
    let json_stem = wav_path.with_extension("");
    cmd.arg("-oj").arg("-of").arg(&json_stem);

    #[cfg(windows)]
    {
        // Suppress console window on Windows.
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // Always surface whisper-cli's stderr to the host stderr so users can
    // see CUDA init logs ("ggml_init_cublas: ...") and confirm GPU usage.
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.stderr.is_empty() {
        eprintln!(
            "[whisper-cli] {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = fs::remove_file(&wav_path).await;
        return Err(format!(
            "whisper-cli failed (exit {:?}): {}",
            output.status.code(),
            stderr.trim()
        ));
    }
    let stdout_text = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let json_path = json_stem.with_extension("json");
    let mut lang_detected = lang.to_string();
    if json_path.exists() {
        if let Ok(s) = fs::read_to_string(&json_path).await {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(l) = v
                    .get("result")
                    .and_then(|r| r.get("language"))
                    .and_then(|l| l.as_str())
                {
                    lang_detected = l.to_string();
                }
            }
        }
        let _ = fs::remove_file(&json_path).await;
    }

    let _ = fs::remove_file(&wav_path).await;

    let duration_ms = started.elapsed().as_millis() as u64;
    Ok(TranscribeOutput {
        text: stdout_text,
        language_detected: lang_detected,
        duration_ms,
    })
}
