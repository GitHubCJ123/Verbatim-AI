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
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WhisperRuntimeVariant {
    Cpu,
    Vulkan,
    Cuda,
    Metal,
}

impl WhisperRuntimeVariant {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Vulkan => "vulkan",
            Self::Cuda => "cuda",
            Self::Metal => "metal",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WhisperComputePreference {
    Auto,
    Cpu,
    Vulkan,
    Cuda,
}

impl WhisperComputePreference {
    fn from_str(s: Option<&str>) -> Self {
        match s {
            Some("cpu") => Self::Cpu,
            Some("vulkan") => Self::Vulkan,
            Some("cuda") => Self::Cuda,
            _ => Self::Auto,
        }
    }
}

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

fn variant_bin_dir(app: &AppHandle, variant: WhisperRuntimeVariant) -> Result<PathBuf, String> {
    let dir = bin_dir(app)?.join(variant.as_str());
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

fn locate_whisper_cli_in_dir(dir: &Path) -> Option<PathBuf> {
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
    walk(dir, target)
}

fn locate_whisper_cli_for_variant(
    app: &AppHandle,
    variant: WhisperRuntimeVariant,
) -> Result<Option<PathBuf>, String> {
    let dir = variant_bin_dir(app, variant)?;
    Ok(locate_whisper_cli_in_dir(&dir))
}

fn locate_legacy_whisper_cli(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let dir = bin_dir(app)?;
    Ok(locate_whisper_cli_in_dir(&dir))
}

// --- Persistent whisper-server support (issue #23, P0) ---------------------
// Clean-room reimplementation of the "warm resident model" behaviour: instead
// of spawning `whisper-cli` per utterance (cold model load each time), we run
// the official `whisper-server` binary once and keep the model resident. These
// helpers resolve the model + server binary + GPU variant, reusing the exact
// same runtime layout as the CLI path. No code is copied from any other project.

fn whisper_server_name() -> &'static str {
    #[cfg(windows)]
    {
        "whisper-server.exe"
    }
    #[cfg(not(windows))]
    {
        "whisper-server"
    }
}

fn locate_whisper_server_in_dir(dir: &Path) -> Option<PathBuf> {
    let target = whisper_server_name();
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
    walk(dir, target)
}

fn locate_whisper_server_for_variant(
    app: &AppHandle,
    variant: WhisperRuntimeVariant,
) -> Result<Option<PathBuf>, String> {
    let dir = variant_bin_dir(app, variant)?;
    Ok(locate_whisper_server_in_dir(&dir))
}

/// Everything the persistent whisper-server manager needs to launch a server.
pub(crate) struct WhisperServerLaunch {
    pub model_path: PathBuf,
    pub server_bin: PathBuf,
    /// GPU-variant label ("cpu" | "vulkan" | "cuda" | "metal"), part of the
    /// warm-server cache key so a variant change forces a respawn.
    pub variant_label: &'static str,
    /// Pass `-fa` (flash attention) for CUDA/Metal, mirroring `run_whisper_cli`.
    pub flash_attn: bool,
}

/// Resolve the model path, `whisper-server` binary, and GPU variant for a tier,
/// or a user-facing error if the model / runtime is missing.
pub(crate) fn resolve_whisper_server_launch(
    app: &AppHandle,
    tier: &str,
    compute_preference: Option<&str>,
) -> Result<WhisperServerLaunch, String> {
    let t = WhisperTier::from_str(tier).ok_or_else(|| format!("unknown tier: {tier}"))?;
    let model_path = models_dir(app)?.join(t.file_name());
    if !model_path.exists() {
        return Err(format!(
            "Model '{tier}' is not downloaded yet. Download it from Settings → AI model."
        ));
    }
    let variant = resolve_runtime_variant(compute_preference);
    let server_bin = locate_whisper_server_for_variant(app, variant)?.ok_or_else(|| {
        format!(
            "whisper-server ({}) is not installed. Update the Whisper runtime in Settings → AI model.",
            variant.as_str()
        )
    })?;
    Ok(WhisperServerLaunch {
        model_path,
        server_bin,
        variant_label: variant.as_str(),
        flash_attn: matches!(
            variant,
            WhisperRuntimeVariant::Cuda | WhisperRuntimeVariant::Metal
        ),
    })
}

/// Recursive list of every file under `root`. Used to chmod whisper-cli
/// + dylibs after extraction (zip drops the executable bit).
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

#[cfg(windows)]
fn windows_system32_file_exists(name: &str) -> bool {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    Path::new(&system_root).join("System32").join(name).exists()
}

fn default_runtime_variant() -> WhisperRuntimeVariant {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        if windows_system32_file_exists("nvcuda.dll") {
            WhisperRuntimeVariant::Cuda
        } else if windows_system32_file_exists("vulkan-1.dll") {
            WhisperRuntimeVariant::Vulkan
        } else {
            WhisperRuntimeVariant::Cpu
        }
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        WhisperRuntimeVariant::Metal
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
    )))]
    {
        WhisperRuntimeVariant::Cpu
    }
}

fn resolve_runtime_variant(preference: Option<&str>) -> WhisperRuntimeVariant {
    match WhisperComputePreference::from_str(preference) {
        WhisperComputePreference::Auto => default_runtime_variant(),
        WhisperComputePreference::Cpu => WhisperRuntimeVariant::Cpu,
        WhisperComputePreference::Vulkan => WhisperRuntimeVariant::Vulkan,
        WhisperComputePreference::Cuda => WhisperRuntimeVariant::Cuda,
    }
}

struct RuntimeAsset {
    name: &'static str,
    url: String,
}

#[derive(Deserialize)]
struct RuntimeManifest {
    assets: std::collections::HashMap<String, RuntimeManifestAsset>,
}

#[derive(Deserialize)]
struct RuntimeManifestAsset {
    sha256: String,
}

const RUNTIME_MANIFEST_NAME: &str = "whisper-runtimes.json";
const MINISIGN_PUBLIC_KEY: &str = "untrusted comment: minisign public key: 89A198BC00AE1902\nRWQCGa4AvJihibrPt0tf7NaYo91fwiVD6F8qMvToNlJEdsu9G6hqLY6P";

fn release_asset_url(asset: &str) -> String {
    format!(
        "https://github.com/GitHubCJ123/Verbatim-AI/releases/download/v{}/{}",
        env!("CARGO_PKG_VERSION"),
        asset
    )
}

fn release_asset_base_url() -> String {
    format!(
        "https://github.com/GitHubCJ123/Verbatim-AI/releases/download/v{}",
        env!("CARGO_PKG_VERSION")
    )
}

fn runtime_archive_url(variant: WhisperRuntimeVariant) -> Result<RuntimeAsset, String> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        let name = match variant {
            WhisperRuntimeVariant::Cpu => "whisper-bin-windows-x64-cpu.zip",
            WhisperRuntimeVariant::Vulkan => "whisper-bin-windows-x64-vulkan.zip",
            WhisperRuntimeVariant::Cuda => "whisper-bin-windows-x64-cuda.zip",
            WhisperRuntimeVariant::Metal => {
                return Err("Metal Whisper runtime is only available on macOS.".into())
            }
        };
        return Ok(RuntimeAsset { name, url: release_asset_url(name) });
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let name = match variant {
            WhisperRuntimeVariant::Metal => "whisper-bin-macos-arm64.zip",
            _ => return Err("This Whisper compute backend is not available on macOS.".into()),
        };
        return Ok(RuntimeAsset { name, url: release_asset_url(name) });
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
    )))]
    {
        return Err("No prebuilt whisper.cpp runtime is available for this platform yet.".into());
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn verified_runtime_manifest(client: &reqwest::Client) -> Result<RuntimeManifest, String> {
    let base = release_asset_base_url();
    let manifest_url = format!("{base}/{RUNTIME_MANIFEST_NAME}");
    let sig_url = format!("{manifest_url}.sig");
    let manifest_bytes = client
        .get(&manifest_url)
        .send()
        .await
        .map_err(|e| runtime_download_error("manifest", &manifest_url, e))?
        .error_for_status()
        .map_err(|e| runtime_download_error("manifest", &manifest_url, e))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    let signature_text = client
        .get(&sig_url)
        .send()
        .await
        .map_err(|e| runtime_download_error("manifest signature", &sig_url, e))?
        .error_for_status()
        .map_err(|e| runtime_download_error("manifest signature", &sig_url, e))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let public_key = PublicKey::decode(MINISIGN_PUBLIC_KEY).map_err(|e| e.to_string())?;
    let signature = Signature::decode(&signature_text).map_err(|e| e.to_string())?;
    public_key
        .verify(&manifest_bytes, &signature, false)
        .map_err(|e| format!("Whisper runtime manifest signature verification failed: {e}"))?;
    serde_json::from_slice::<RuntimeManifest>(&manifest_bytes).map_err(|e| e.to_string())
}

async fn bundled_runtime_manifest(app: &AppHandle) -> Result<Option<RuntimeManifest>, String> {
    let Some((manifest_bytes, signature_text)) = bundled_manifest_bytes(app).await? else {
        return Ok(None);
    };
    verify_runtime_manifest_bytes(&manifest_bytes, &signature_text)?;
    serde_json::from_slice::<RuntimeManifest>(&manifest_bytes)
        .map(Some)
        .map_err(|e| e.to_string())
}

async fn bundled_manifest_bytes(app: &AppHandle) -> Result<Option<(Vec<u8>, String)>, String> {
    let Some(dir) = bundled_runtime_dir(app) else {
        return Ok(None);
    };
    let manifest_path = dir.join(RUNTIME_MANIFEST_NAME);
    let sig_path = dir.join(format!("{RUNTIME_MANIFEST_NAME}.sig"));
    if !manifest_path.exists() || !sig_path.exists() {
        return Ok(None);
    }
    let manifest = fs::read(&manifest_path).await.map_err(|e| e.to_string())?;
    let signature = fs::read_to_string(&sig_path).await.map_err(|e| e.to_string())?;
    Ok(Some((manifest, signature)))
}

fn verify_runtime_manifest_bytes(manifest_bytes: &[u8], signature_text: &str) -> Result<(), String> {
    let public_key = PublicKey::decode(MINISIGN_PUBLIC_KEY).map_err(|e| e.to_string())?;
    let signature = Signature::decode(signature_text).map_err(|e| e.to_string())?;
    public_key
        .verify(manifest_bytes, &signature, false)
        .map_err(|e| format!("Whisper runtime manifest signature verification failed: {e}"))
}

fn bundled_runtime_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app
        .path()
        .resource_dir()
        .ok()?
        .join("whisper-runtimes"))
}

fn bundled_runtime_asset(app: &AppHandle, asset_name: &str) -> Option<PathBuf> {
    let path = bundled_runtime_dir(app)?.join(asset_name);
    path.exists().then_some(path)
}

fn runtime_download_error(kind: &str, url: &str, e: reqwest::Error) -> String {
    if e.status() == Some(reqwest::StatusCode::NOT_FOUND) {
        return format!(
            "Could not download the Whisper runtime {kind} for Verbatim AI v{} from {url}. \
             The GitHub release assets are not publicly available yet. Publish the v{} release \
             or install a Verbatim AI version whose Local Whisper runtime assets are published.",
            env!("CARGO_PKG_VERSION"),
            env!("CARGO_PKG_VERSION"),
        );
    }
    format!("Could not download the Whisper runtime {kind} from {url}: {e}")
}

#[tauri::command]
pub async fn detect_whisper_compute_backend() -> Result<String, String> {
    Ok(default_runtime_variant().as_str().to_string())
}

#[tauri::command]
pub async fn get_active_whisper_runtime_variant(
    preference: Option<String>,
) -> Result<String, String> {
    Ok(resolve_runtime_variant(preference.as_deref()).as_str().to_string())
}

#[tauri::command]
pub async fn is_whisper_runtime_installed(
    app: AppHandle,
    preference: Option<String>,
) -> Result<bool, String> {
    let variant = resolve_runtime_variant(preference.as_deref());
    Ok(locate_whisper_cli_for_variant(&app, variant)?.is_some()
        || (matches!(
            variant,
            WhisperRuntimeVariant::Cuda | WhisperRuntimeVariant::Metal
        ) && locate_legacy_whisper_cli(&app)?.is_some()))
}

#[derive(Serialize, Clone)]
struct RuntimeProgress {
    downloaded: u64,
    total: u64,
}

#[tauri::command]
pub async fn install_whisper_runtime(
    app: AppHandle,
    preference: Option<String>,
) -> Result<(), String> {
    let variant = resolve_runtime_variant(preference.as_deref());
    install_whisper_runtime_variant(&app, variant).await
}

async fn install_whisper_runtime_variant(
    app: &AppHandle,
    variant: WhisperRuntimeVariant,
) -> Result<(), String> {
    let asset = runtime_archive_url(variant)?;
    let dir = variant_bin_dir(app, variant)?;

    // Always reinstall this variant fresh: wipe any previous extraction
    // so URL/version changes are picked up without deleting other variants.
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
    let tmp_zip = dir.join(format!("whisper-bin-{}.partial.zip", variant.as_str()));

    let client = reqwest::Client::builder()
        .user_agent("Verbatim-AI/0.2 (+https://github.com/GitHubCJ123/Verbatim-AI)")
        .build()
        .map_err(|e| e.to_string())?;
    let manifest = match bundled_runtime_manifest(app).await? {
        Some(manifest) => manifest,
        None => verified_runtime_manifest(&client).await?,
    };
    let expected_sha = manifest
        .assets
        .get(asset.name)
        .ok_or_else(|| format!("{} is missing from signed runtime manifest", asset.name))?
        .sha256
        .to_ascii_lowercase();

    let mut file = fs::File::create(&tmp_zip)
        .await
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();

    if let Some(bundled_path) = bundled_runtime_asset(app, asset.name) {
        let bytes = fs::read(&bundled_path).await.map_err(|e| e.to_string())?;
        hasher.update(&bytes);
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        let total = bytes.len() as u64;
        let _ = app.emit(
            "local-whisper:runtime:progress",
            RuntimeProgress {
                downloaded: total,
                total,
            },
        );
    } else {
        let res = client
            .get(&asset.url)
            .send()
            .await
            .map_err(|e| runtime_download_error(asset.name, &asset.url, e))?;
        if !res.status().is_success() {
            if res.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(runtime_download_error(
                    asset.name,
                    &asset.url,
                    res.error_for_status().unwrap_err(),
                ));
            }
            return Err(format!(
                "download failed: HTTP {} from {}",
                res.status(),
                asset.url
            ));
        }
        let total = res.content_length().unwrap_or(0);
        let mut stream = res.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut last_emit = Instant::now();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| e.to_string())?;
            hasher.update(&bytes);
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
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    let actual_sha = hex_lower(&hasher.finalize());
    if actual_sha != expected_sha {
        let _ = fs::remove_file(&tmp_zip).await;
        return Err(format!(
            "Whisper runtime checksum mismatch for {}: expected {}, got {}",
            variant.as_str(),
            expected_sha,
            actual_sha
        ));
    }

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

        // macOS/Linux: zip doesn't preserve the executable bit and
        // macOS slaps a com.apple.quarantine xattr on anything that
        // came from a download. Without those two fixes, running
        // whisper-cli yields EACCES (permission denied) or Gatekeeper
        // refuses to launch it.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for entry in walk_dir(&extract_dir) {
                let name = entry.file_name().and_then(|s| s.to_str()).unwrap_or("");
                let is_exec = name == "whisper-cli"
                    || name.ends_with(".dylib")
                    || name.ends_with(".so");
                if is_exec {
                    if let Ok(meta) = std::fs::metadata(&entry) {
                        let mut perms = meta.permissions();
                        // 0o755 = rwxr-xr-x
                        perms.set_mode(perms.mode() | 0o111);
                        let _ = std::fs::set_permissions(&entry, perms);
                    }
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            // Strip the quarantine attribute recursively. Best-effort;
            // it's fine if xattr isn't there.
            let _ = std::process::Command::new("xattr")
                .args(["-d", "-r", "com.apple.quarantine"])
                .arg(&extract_dir)
                .status();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    let _ = fs::remove_file(&tmp_zip).await;

    if locate_whisper_cli_for_variant(app, variant)?.is_none() {
        return Err(format!(
            "Extraction finished but {} was not found in the archive",
            whisper_cli_name()
        ));
    }
    let _ = app.emit("local-whisper:runtime:complete", variant.as_str().to_string());
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
    pub compute_preference: Option<String>,
    /// 16 kHz mono Float32 PCM samples.
    pub pcm: Vec<f32>,
}

#[derive(Serialize)]
pub struct TranscribeOutput {
    pub(crate) text: String,
    pub(crate) language_detected: String,
    pub(crate) duration_ms: u64,
}

struct WhisperRunError {
    message: String,
    stderr: String,
    code: Option<i32>,
}

/// Write 16 kHz mono f32 PCM to a fresh temp WAV under `whisper-tmp` and return
/// its path. Shared by the CLI path and the persistent whisper-server path.
pub(crate) fn write_pcm_wav(app: &AppHandle, samples: &[f32]) -> Result<PathBuf, String> {
    let tmp_dir = app_data(app)?.join("whisper-tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let wav_path = tmp_dir.join(format!(
        "rec-{}.wav",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    write_wav(&wav_path, samples)?;
    Ok(wav_path)
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

async fn run_whisper_cli(
    cli_path: &Path,
    model_path: &Path,
    wav_path: &Path,
    json_stem: &Path,
    args: &TranscribeArgs,
    variant: WhisperRuntimeVariant,
) -> Result<TranscribeOutput, WhisperRunError> {
    let started = Instant::now();

    let mut cmd = Command::new(&cli_path);
    cmd.arg("-m").arg(&model_path);
    cmd.arg("-f").arg(&wav_path);
    cmd.arg("-nt");
    if matches!(variant, WhisperRuntimeVariant::Cuda | WhisperRuntimeVariant::Metal) {
        cmd.arg("-fa");
    }
    let lang = args.language.as_deref().unwrap_or("auto");
    cmd.arg("-l").arg(lang);
    if args.translate.unwrap_or(false) {
        cmd.arg("-tr");
    }
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
    let output = cmd.output().await.map_err(|e| WhisperRunError {
        message: e.to_string(),
        stderr: String::new(),
        code: None,
    })?;
    if !output.stderr.is_empty() {
        eprintln!(
            "[whisper-cli] {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(WhisperRunError {
            message: format!(
                "whisper-cli failed (exit {:?}): {}",
                output.status.code(),
                stderr.trim()
            ),
            stderr: stderr.to_string(),
            code: output.status.code(),
        });
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

    let duration_ms = started.elapsed().as_millis() as u64;
    Ok(TranscribeOutput {
        text: stdout_text,
        language_detected: lang_detected,
        duration_ms,
    })
}

fn should_fallback_to_cpu(variant: WhisperRuntimeVariant, e: &WhisperRunError) -> bool {
    if variant == WhisperRuntimeVariant::Cpu {
        return false;
    }
    if e.code == Some(-1073741515) {
        return true;
    }
    let hay = format!("{} {}", e.message, e.stderr).to_lowercase();
    [
        "nvcuda.dll",
        "ggml-cuda.dll",
        "cublas64_",
        "cudart64_",
        "cuda error",
        "failed to initialize cuda",
        "vulkan-1.dll",
        "no vulkan device",
        "vkcreatedevice",
        "vkenumeratephysicaldevices",
        "dll was not found",
    ]
    .iter()
    .any(|needle| hay.contains(needle))
}

#[derive(Serialize, Clone)]
struct RuntimeFallbackPayload {
    from: String,
    to: String,
    reason: String,
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

    if args.pcm.is_empty() {
        return Err("Empty audio buffer".into());
    }

    let variant = resolve_runtime_variant(args.compute_preference.as_deref());
    let cli_path = locate_whisper_cli_for_variant(&app, variant)?
        .or_else(|| {
            if matches!(
                variant,
                WhisperRuntimeVariant::Cuda | WhisperRuntimeVariant::Metal
            ) {
                locate_legacy_whisper_cli(&app).ok().flatten()
            } else {
                None
            }
        })
        .ok_or_else(|| {
            format!(
                "whisper.cpp {} runtime is not installed. Click Install in Settings → AI model.",
                variant.as_str()
            )
        })?;

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
    let json_stem = wav_path.with_extension("");

    let output: Result<TranscribeOutput, String> = async {
        let result =
            run_whisper_cli(&cli_path, &model_path, &wav_path, &json_stem, &args, variant).await;
        match result {
            Ok(out) => Ok(out),
            Err(e) if should_fallback_to_cpu(variant, &e) => {
                let cpu = WhisperRuntimeVariant::Cpu;
                if locate_whisper_cli_for_variant(&app, cpu)?.is_none() {
                    install_whisper_runtime_variant(&app, cpu).await?;
                }
                let cpu_cli = locate_whisper_cli_for_variant(&app, cpu)?.ok_or_else(|| {
                    "CPU Whisper runtime install completed but whisper-cli was not found."
                        .to_string()
                })?;
                let _ = app.emit(
                    "local-whisper:runtime:fallback",
                    RuntimeFallbackPayload {
                        from: variant.as_str().to_string(),
                        to: cpu.as_str().to_string(),
                        reason: e.message.clone(),
                    },
                );
                run_whisper_cli(&cpu_cli, &model_path, &wav_path, &json_stem, &args, cpu)
                    .await
                    .map_err(|cpu_err| cpu_err.message)
            }
            Err(e) => Err(e.message),
        }
    }
    .await;

    let _ = fs::remove_file(&wav_path).await;
    let _ = fs::remove_file(json_stem.with_extension("json")).await;
    output
}
