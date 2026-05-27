//! Parakeet TDT v3 transcription via the sherpa-onnx CPU sidecar.
//!
//! Mirrors `local_whisper.rs`: we download a prebuilt `sherpa-onnx-offline`
//! binary plus a Parakeet ONNX model bundle into the app data dir and shell
//! out per transcription. CPU-only — no CUDA/CoreML providers in this build.
//!
//! Layout under `app_data_dir`:
//!   parakeet-bin/sherpa-onnx-offline(.exe)   (+ supporting DLLs/dylibs)
//!   parakeet-models/v3/encoder.int8.onnx
//!   parakeet-models/v3/decoder.int8.onnx
//!   parakeet-models/v3/joiner.int8.onnx
//!   parakeet-models/v3/tokens.txt

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs;
use tokio::io::AsyncWriteExt;
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
    let target = cli_name();
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

#[cfg(unix)]
fn walk_dir(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn inner(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                out.push(p);
            } else if p.is_dir() {
                inner(&p, out);
            }
        }
    }
    inner(root, &mut out);
    out
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
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!(
            "download failed: HTTP {} from {}",
            res.status(),
            url
        ));
    }
    let total = res.content_length().unwrap_or(0);

    let mut file = fs::File::create(dest).await.map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;
        if last_emit.elapsed().as_millis() > 200 {
            last_emit = Instant::now();
            let _ = app.emit(progress_event, Progress { downloaded, total });
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    let _ = app.emit(
        progress_event,
        Progress {
            downloaded: total.max(downloaded),
            total: total.max(downloaded),
        },
    );
    Ok(())
}

/// Extract a .tar.bz2 archive into `dest`, blocking. Run inside spawn_blocking.
fn extract_tar_bz2(archive: &Path, dest: &Path) -> Result<(), String> {
    let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let bz = bzip2::read::BzDecoder::new(f);
    let mut ar = tar::Archive::new(bz);
    // On Windows the tar crate fails to set Unix ownership/perms on extracted
    // files; on macOS we re-apply exec bits after extraction anyway.
    ar.set_preserve_permissions(false);
    ar.set_preserve_mtime(false);
    ar.set_unpack_xattrs(false);
    ar.set_overwrite(true);
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in ar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let rel = match entry.path() {
            Ok(p) => p.into_owned(),
            Err(_) => continue,
        };
        // Skip anything that tries to escape via `..`.
        if rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            continue;
        }
        let out = dest.join(&rel);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Unpack data only; ignore metadata that may fail on Windows.
        let mut writer = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut writer).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn fix_unix_perms_and_quarantine(_extract_dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for entry in walk_dir(_extract_dir) {
            let name = entry.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let is_exec = name == "sherpa-onnx-offline"
                || name.ends_with(".dylib")
                || name.ends_with(".so");
            if is_exec {
                if let Ok(meta) = std::fs::metadata(&entry) {
                    let mut perms = meta.permissions();
                    perms.set_mode(perms.mode() | 0o111);
                    let _ = std::fs::set_permissions(&entry, perms);
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("xattr")
            .args(["-d", "-r", "com.apple.quarantine"])
            .arg(_extract_dir)
            .status();
    }
}

#[tauri::command]
pub async fn is_parakeet_runtime_installed(app: AppHandle) -> Result<bool, String> {
    Ok(locate_cli(&app)?.is_some())
}

#[tauri::command]
pub async fn install_parakeet_runtime(app: AppHandle) -> Result<(), String> {
    let url = runtime_archive_url()?;
    let dir = bin_dir(&app)?;

    // Wipe any previous extraction so we pick up version changes.
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
    let tmp_archive = dir.join("parakeet-runtime.partial.tar.bz2");
    stream_download(&app, url, &tmp_archive, "parakeet:runtime:progress").await?;

    let extract_dir = dir.clone();
    let tmp_for_extract = tmp_archive.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        extract_tar_bz2(&tmp_for_extract, &extract_dir)?;
        fix_unix_perms_and_quarantine(&extract_dir);
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
        extract_tar_bz2(&tmp_for_extract, &staging_for_extract)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Find each required file under staging and move it up into models_dir.
    for fname in model_files() {
        let mut found: Option<PathBuf> = None;
        fn search(dir: &Path, target: &str, out: &mut Option<PathBuf>) {
            if out.is_some() {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    if p.file_name().and_then(|n| n.to_str()) == Some(target) {
                        *out = Some(p);
                        return;
                    }
                } else if p.is_dir() {
                    search(&p, target, out);
                    if out.is_some() {
                        return;
                    }
                }
            }
        }
        search(&staging, fname, &mut found);
        let src = found.ok_or_else(|| format!("'{}' missing from archive", fname))?;
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
pub async fn delete_parakeet_model(app: AppHandle, variant: String) -> Result<(), String> {
    let v = parse_variant(&variant)?;
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
    f.write_all(&chunk_size.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(b"WAVE").map_err(|e| e.to_string())?;
    f.write_all(b"fmt ").map_err(|e| e.to_string())?;
    f.write_all(&16u32.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&1u16.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&num_channels.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&sample_rate.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&byte_rate.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&block_align.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&bits_per_sample.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(b"data").map_err(|e| e.to_string())?;
    f.write_all(&data_bytes.to_le_bytes()).map_err(|e| e.to_string())?;
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
pub async fn transcribe_parakeet(
    app: AppHandle,
    args: TranscribeArgs,
) -> Result<TranscribeOutput, String> {
    let v = parse_variant(&args.variant)?;
    let dir = models_dir(&app, v)?;
    for fname in model_files() {
        if !dir.join(fname).exists() {
            return Err(format!(
                "Parakeet {} model file '{}' is missing. Download it from Settings → AI model.",
                v.tag(),
                fname
            ));
        }
    }
    let cli = locate_cli(&app)?.ok_or_else(|| {
        "sherpa-onnx runtime is not installed. Click 'Install runtime' in Settings → AI model."
            .to_string()
    })?;

    if args.pcm.is_empty() {
        return Err("Empty audio buffer".into());
    }

    let tmp_dir = app_data(&app)?.join("parakeet-tmp");
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
    let mut cmd = Command::new(&cli);
    cmd.arg(format!(
        "--encoder={}",
        dir.join("encoder.int8.onnx").display()
    ));
    cmd.arg(format!(
        "--decoder={}",
        dir.join("decoder.int8.onnx").display()
    ));
    cmd.arg(format!(
        "--joiner={}",
        dir.join("joiner.int8.onnx").display()
    ));
    cmd.arg(format!("--tokens={}", dir.join("tokens.txt").display()));
    cmd.arg("--model-type=nemo_transducer");
    cmd.arg("--num-threads=4");
    cmd.arg(&wav_path);

    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output().await.map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&wav_path).await;
    if !output.stderr.is_empty() {
        eprintln!(
            "[sherpa-onnx] {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
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
    let text = extract_transcript(&stdout).unwrap_or_else(|| stdout.trim().to_string());

    let duration_ms = started.elapsed().as_millis() as u64;
    Ok(TranscribeOutput {
        text,
        language_detected: args.language.unwrap_or_else(|| "auto".into()),
        duration_ms,
    })
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
