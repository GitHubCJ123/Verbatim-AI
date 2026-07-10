use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use bzip2::read::BzDecoder;
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::io::AsyncWriteExt;

#[derive(Clone, Copy)]
pub(crate) struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
}

pub(crate) struct DownloadResult {
    pub downloaded: u64,
    pub total: u64,
}

pub(crate) async fn download_with_progress<F, RE, SE>(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    throttle: Duration,
    mut on_progress: F,
    map_request_error: RE,
    map_status_error: SE,
) -> Result<DownloadResult, String>
where
    F: FnMut(DownloadProgress),
    RE: Fn(reqwest::Error) -> String,
    SE: Fn(reqwest::StatusCode, &str) -> String,
{
    let res = client.get(url).send().await.map_err(map_request_error)?;
    if !res.status().is_success() {
        return Err(map_status_error(res.status(), url));
    }
    let total = res.content_length().unwrap_or(0);

    let mut file = fs::File::create(dest).await.map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut downloaded = 0u64;
    let mut last_emit = Instant::now();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;
        if last_emit.elapsed() > throttle {
            last_emit = Instant::now();
            on_progress(DownloadProgress { downloaded, total });
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(DownloadResult { downloaded, total })
}

pub(crate) fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    let actual = hex_lower(&hasher.finalize());
    if actual != expected {
        return Err(format!("expected {expected}, got {actual}"));
    }
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn verify_minisign(
    bytes: &[u8],
    signature_text: &str,
    public_key_text: &str,
    verification_failure_prefix: &str,
) -> Result<(), String> {
    let public_key = PublicKey::decode(public_key_text).map_err(|e| e.to_string())?;
    let signature = Signature::decode(signature_text).map_err(|e| e.to_string())?;
    public_key
        .verify(bytes, &signature, false)
        .map_err(|e| format!("{verification_failure_prefix}: {e}"))
}

#[derive(Clone, Copy)]
pub(crate) enum ArchiveKind {
    Zip,
    TarGz,
    TarBz2,
}

impl ArchiveKind {
    pub(crate) fn from_file_name(name: &str) -> Option<Self> {
        if name.ends_with(".zip") {
            Some(Self::Zip)
        } else if name.ends_with(".tar.gz") {
            Some(Self::TarGz)
        } else if name.ends_with(".tar.bz2") {
            Some(Self::TarBz2)
        } else {
            None
        }
    }
}

pub(crate) fn extract_archive(archive: &Path, dest: &Path, kind: ArchiveKind) -> Result<(), String> {
    match kind {
        ArchiveKind::Zip => extract_zip(archive, dest),
        ArchiveKind::TarGz => extract_tar_gz(archive, dest),
        ArchiveKind::TarBz2 => extract_tar_bz2(archive, dest),
    }
}

fn extract_zip(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let f = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let rel = match entry.enclosed_name() {
            Some(p) => p.to_owned(),
            None => continue,
        };
        let out_path = dest.join(&rel);
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
}

fn extract_tar_gz(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let f = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let gz = GzDecoder::new(f);
    let mut archive = tar::Archive::new(gz);
    archive.unpack(dest).map_err(|e| e.to_string())
}

fn extract_tar_bz2(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let f = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let bz = BzDecoder::new(f);
    let mut ar = tar::Archive::new(bz);
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
        // Skip path-traversal AND absolute-path entries so a malicious archive
        // can't write outside `dest`. This is the only extraction guard for
        // parakeet's sherpa-onnx archives, which have no checksum/signature.
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
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
        let mut writer = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut writer).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn make_executables(root: &Path, executable_names: &[&str]) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for entry in walk_files(root) {
            let name = entry.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let is_exec = executable_names.contains(&name)
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
    #[cfg(not(unix))]
    {
        let _ = root;
        let _ = executable_names;
    }
}

pub(crate) fn strip_quarantine(root: &Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("xattr")
            .args(["-d", "-r", "com.apple.quarantine"])
            .arg(root)
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = root;
    }
}

pub(crate) fn locate_executable(dir: &Path, target: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() {
            if p.file_name().and_then(|n| n.to_str()) == Some(target) {
                return Some(p);
            }
        } else if p.is_dir() {
            if let Some(found) = locate_executable(&p, target) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(unix)]
fn walk_files(root: &Path) -> Vec<PathBuf> {
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

pub(crate) fn clear_dir_contents(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            } else {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    Ok(())
}
