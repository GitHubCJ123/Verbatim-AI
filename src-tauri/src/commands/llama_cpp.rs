//! Local cleanup via llama.cpp sidecar binary.
//!
//! We download the official prebuilt `llama-cli` runtime from the latest
//! ggml-org/llama.cpp GitHub release into the app data dir, then shell out
//! for text cleanup. Models are addressed with llama.cpp's `-hf` Hugging Face
//! shorthand (for example `ggml-org/gemma-3-1b-it-GGUF`) so llama.cpp owns
//! model download/cache behavior.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::timeout;

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data(app)?.join("llama-cpp-bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn llama_cli_name() -> &'static str {
    #[cfg(windows)]
    {
        "llama-cli.exe"
    }
    #[cfg(not(windows))]
    {
        "llama-cli"
    }
}

fn locate_llama_cli(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let dir = bin_dir(app)?;
    let target = llama_cli_name();
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
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
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
        Err("No prebuilt llama.cpp runtime is available for this platform yet.".into())
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[tauri::command]
pub async fn is_llama_cpp_runtime_installed(app: AppHandle) -> Result<bool, String> {
    Ok(locate_llama_cli(&app)?.is_some())
}

#[derive(Serialize, Clone)]
struct RuntimeProgress {
    downloaded: u64,
    total: u64,
}

#[tauri::command]
pub async fn install_llama_cpp_runtime(app: AppHandle) -> Result<(), String> {
    let asset = runtime_asset()?;
    let dir = bin_dir(&app)?;
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
    let tmp_path = dir.join(format!("{}.partial", asset.name));

    let client = reqwest::Client::builder()
        .user_agent("Verbatim-AI/0.5 (+https://github.com/GitHubCJ123/Verbatim-AI)")
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(asset.url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!(
            "download failed: HTTP {} from {}",
            res.status(),
            asset.url
        ));
    }
    let total = res.content_length().unwrap_or(0);
    let mut file = fs::File::create(&tmp_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut downloaded = 0u64;
    let mut last_emit = Instant::now();
    let mut hasher = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        hasher.update(&bytes);
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;
        if last_emit.elapsed().as_millis() > 150 {
            last_emit = Instant::now();
            let _ = app.emit(
                "llama-cpp:runtime:progress",
                RuntimeProgress { downloaded, total },
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    let actual_sha = hex_lower(&hasher.finalize());
    if actual_sha != asset.sha256 {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(format!(
            "llama.cpp runtime checksum mismatch for {}: expected {}, got {}",
            asset.name, asset.sha256, actual_sha
        ));
    }

    let extract_dir = dir.clone();
    let tmp_for_extract = tmp_path.clone();
    let asset_for_extract = asset.name.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if asset_for_extract.ends_with(".zip") {
            let f = std::fs::File::open(&tmp_for_extract).map_err(|e| e.to_string())?;
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
        } else {
            let f = std::fs::File::open(&tmp_for_extract).map_err(|e| e.to_string())?;
            let gz = GzDecoder::new(f);
            let mut archive = tar::Archive::new(gz);
            archive.unpack(&extract_dir).map_err(|e| e.to_string())?;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for entry in walk_dir(&extract_dir) {
                let name = entry.file_name().and_then(|s| s.to_str()).unwrap_or("");
                let is_exec = name == "llama-cli"
                    || name == "llama-server"
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
                .arg(&extract_dir)
                .status();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    let _ = fs::remove_file(&tmp_path).await;
    if locate_llama_cli(&app)?.is_none() {
        return Err(format!(
            "Extraction finished but {} was not found in the archive",
            llama_cli_name()
        ));
    }
    let _ = app.emit("llama-cpp:runtime:complete", asset.name);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlamaCleanupArgs {
    /// Hugging Face model reference accepted by `llama-cli -hf`, e.g.
    /// `ggml-org/gemma-3-1b-it-GGUF`.
    pub model: String,
    pub prompt: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

/// Per-model async lock so concurrent `cleanup_llama_cpp` calls for the same
/// Hugging Face model don't spawn racing `llama-cli -hf` downloads. On first
/// use llama.cpp downloads the GGUF into the shared HF cache; two processes
/// fetching the same model collide on the final `blobs/<sha>` rename ("unable
/// to rename ... .downloadInProgress"). Serializing per model means the first
/// caller downloads and the rest wait, then reuse the cached model.
fn model_download_lock(model: &str) -> Arc<AsyncMutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard
        .entry(model.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

#[tauri::command]
pub async fn cleanup_llama_cpp(app: AppHandle, args: LlamaCleanupArgs) -> Result<String, String> {
    let cli_path = locate_llama_cli(&app)?.ok_or_else(|| {
        "llama.cpp runtime is not installed. Install it from Settings → AI model.".to_string()
    })?;
    if args.model.trim().is_empty() {
        return Err("No llama.cpp model selected. Pick one in Settings → AI model.".into());
    }
    if args.prompt.trim().is_empty() {
        return Err("Cleanup prompt is empty.".into());
    }

    let tmp_dir = app_data(&app)?.join("llama-cpp-tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let prompt_path = tmp_dir.join(format!(
        "cleanup-{}.txt",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    {
        let mut f = std::fs::File::create(&prompt_path).map_err(|e| e.to_string())?;
        f.write_all(args.prompt.as_bytes())
            .map_err(|e| e.to_string())?;
    }

    // Serialize per model: a first-run `-hf` fetch downloads the GGUF into the
    // shared Hugging Face cache. Two concurrent llama-cli processes downloading
    // the same model collide on the final blob rename, so make the download
    // single-flight (later callers wait here, then reuse the cached model).
    let download_guard = model_download_lock(args.model.trim());
    let _download_lock = download_guard.lock().await;

    let mut cmd = Command::new(&cli_path);
    cmd.arg("-hf").arg(args.model.trim());
    cmd.arg("-f").arg(&prompt_path);
    cmd.arg("--simple-io");
    cmd.arg("--no-display-prompt");
    cmd.arg("--temp")
        .arg(format!("{}", args.temperature.unwrap_or(0.3)));
    cmd.arg("-n")
        .arg(format!("{}", args.max_tokens.unwrap_or(768).clamp(32, 4096)));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // Ensure a timed-out llama-cli is actually killed — Tokio does not kill the
    // child when the `output()` future is dropped, so without this a slow
    // first-run download could keep writing to the shared HF cache after we
    // release the per-model lock and let another invocation race it.
    cmd.kill_on_drop(true);

    let output = timeout(Duration::from_secs(10 * 60), cmd.output())
        .await
        .map_err(|_| "llama.cpp cleanup timed out after 10 minutes".to_string())?
        .map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&prompt_path).await;

    if !output.stderr.is_empty() {
        eprintln!(
            "[llama-cli] {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    if !output.status.success() {
        return Err(format!(
            "llama-cli failed (exit {:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
