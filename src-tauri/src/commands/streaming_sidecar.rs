//! Dedicated streaming-transcription sidecar (issue #33).
//!
//! True token-level streaming needs a streaming-capable engine fed by the
//! app's own 16 kHz mono f32 PCM frames — the batch engines (`whisper-cli` /
//! `whisper-server`) are request/response, so the existing live-partial path is
//! only *chunked* pseudo-streaming (see docs/proposals/streaming-sidecar.md).
//!
//! This manager spawns a headless `whisper-stream` sidecar, streams
//! length-prefixed f32 frames to its stdin, and forwards the line-delimited
//! JSON partial/final events it prints on stdout to the overlay via a
//! `stream:partial` Tauri event.
//!
//! Protocol (see the design doc §2.1):
//!   stdin  — `[u32 LE sample_count][sample_count × f32 LE]` per chunk;
//!            a `sample_count` of 0 is the finalize/flush marker.
//!   stdout — one JSON object per line: `{"type":"partial"|"final","text":…}`.
//!
//! Everything is opt-in and default-off (`sw.transcribe.trueStreaming`). Until
//! the sidecar binary is bundled (a deferred CI piece), `is_streaming_sidecar_
//! available` returns false and the frontend falls back to the chunked path.
//! Unlike `whisper_server.rs`, there is **no idle eviction / warm-cache reuse**:
//! a session is scoped to a single recording, created on start and torn down on
//! finish/stop. The core (`StreamingSession`) is Tauri-free so it can be unit
//! tested against a fake sidecar script.

use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::local_whisper::{resolve_streaming_sidecar_launch, StreamingSidecarLaunch};

/// One decoded event forwarded from the sidecar's stdout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StreamEvent {
    /// `"partial"` (revisable hypothesis) or `"final"` (emitted once at the end).
    pub kind: String,
    pub text: String,
}

/// Payload emitted to the overlay for each `stream:partial` event.
#[derive(Serialize, Clone)]
struct StreamPayload {
    #[serde(rename = "sessionId")]
    session_id: u64,
    kind: String,
    text: String,
}

/// Tauri-free streaming session: owns the child process, its stdin writer, and
/// a background task that parses stdout lines into [`StreamEvent`]s.
pub(crate) struct StreamingSession {
    child: tokio::process::Child,
    /// `None` once [`StreamingSession::finish`] has closed stdin.
    stdin: Option<ChildStdin>,
    reader: Option<JoinHandle<()>>,
}

impl StreamingSession {
    /// Spawn `cmd` with piped stdin/stdout and start forwarding parsed events to
    /// `tx`. `cmd` should already carry the model/flags; this only wires I/O.
    pub(crate) fn spawn_command(
        mut cmd: Command,
        tx: UnboundedSender<StreamEvent>,
    ) -> Result<Self, String> {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        cmd.kill_on_drop(true);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to start streaming sidecar: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "streaming sidecar stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "streaming sidecar stdout unavailable".to_string())?;

        let reader = tokio::spawn(async move {
            // A buffered line reader reassembles JSON objects that the OS split
            // across pipe reads; malformed lines are skipped, never fatal.
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                    continue;
                };
                let kind = value
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if kind != "partial" && kind != "final" {
                    continue;
                }
                let text = value
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if tx.send(StreamEvent { kind, text }).is_err() {
                    break; // receiver dropped — stop reading
                }
            }
        });

        Ok(Self {
            child,
            stdin: Some(stdin),
            reader: Some(reader),
        })
    }

    /// Write one length-prefixed chunk of f32 samples to the sidecar. A no-op
    /// (Ok) once the stream has been finished so late flushes can't race.
    pub(crate) async fn send_frames(&mut self, samples: &[f32]) -> Result<(), String> {
        let Some(stdin) = self.stdin.as_mut() else {
            return Ok(());
        };
        let mut buf = Vec::with_capacity(4 + samples.len() * 4);
        buf.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        for s in samples {
            buf.extend_from_slice(&s.to_le_bytes());
        }
        stdin
            .write_all(&buf)
            .await
            .map_err(|e| format!("streaming sidecar write failed: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("streaming sidecar flush failed: {e}"))?;
        Ok(())
    }

    /// Send the finalize marker and close stdin (EOF). Idempotent. The reader
    /// task keeps running so the sidecar's final event is still forwarded.
    pub(crate) async fn finish(&mut self) -> Result<(), String> {
        if let Some(mut stdin) = self.stdin.take() {
            stdin
                .write_all(&0u32.to_le_bytes())
                .await
                .map_err(|e| format!("streaming sidecar finalize failed: {e}"))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("streaming sidecar flush failed: {e}"))?;
            // `stdin` drops here → pipe closes → sidecar sees EOF.
        }
        Ok(())
    }

    /// Terminate the sidecar and stop the reader task. Idempotent.
    pub(crate) async fn stop(&mut self) {
        self.stdin = None;
        let _ = self.child.start_kill();
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
    }
}

struct SessionEntry {
    id: u64,
    session: StreamingSession,
}

/// Managed Tauri state holding the single active streaming session (if any).
pub struct StreamingSidecarState {
    inner: Arc<Mutex<Option<SessionEntry>>>,
    next_id: AtomicU64,
}

impl Default for StreamingSidecarState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            next_id: AtomicU64::new(0),
        }
    }
}

impl StreamingSidecarState {
    async fn start(&self, app: &AppHandle, launch: StreamingSidecarLaunch) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;

        let mut cmd = Command::new(&launch.sidecar_bin);
        cmd.arg("-m").arg(&launch.model_path);
        if launch.flash_attn {
            cmd.arg("-fa");
        }

        if std::env::var("VERBATIM_PERF").ok().as_deref() == Some("1") {
            eprintln!(
                "[verbatim-perf] streaming-sidecar start id={id} variant={}",
                launch.variant_label
            );
        }

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let session = StreamingSession::spawn_command(cmd, tx)?;
        spawn_forwarder(app.clone(), id, rx);

        let mut guard = self.inner.lock().await;
        if let Some(mut old) = guard.take() {
            old.session.stop().await;
        }
        *guard = Some(SessionEntry { id, session });
        Ok(id)
    }

    async fn push(&self, session_id: u64, frames: &[f32]) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        match guard.as_mut() {
            // Ignore frames for a superseded session (stale guard).
            Some(entry) if entry.id == session_id => entry.session.send_frames(frames).await,
            _ => Ok(()),
        }
    }

    async fn finish(&self, session_id: u64) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        match guard.as_mut() {
            Some(entry) if entry.id == session_id => entry.session.finish().await,
            _ => Ok(()),
        }
    }

    async fn stop(&self, session_id: u64) {
        let mut guard = self.inner.lock().await;
        let matches = guard.as_ref().map(|e| e.id == session_id).unwrap_or(false);
        if matches {
            if let Some(mut entry) = guard.take() {
                entry.session.stop().await;
            }
        }
    }

    /// Best-effort synchronous terminate for app shutdown (no async context).
    fn stop_now(&self) {
        if let Ok(mut guard) = self.inner.try_lock() {
            if let Some(mut entry) = guard.take() {
                let _ = entry.session.child.start_kill();
                if let Some(reader) = entry.session.reader.take() {
                    reader.abort();
                }
            }
        }
    }
}

fn spawn_forwarder(app: AppHandle, session_id: u64, mut rx: UnboundedReceiver<StreamEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = app.emit(
                "stream:partial",
                StreamPayload {
                    session_id,
                    kind: event.kind,
                    text: event.text,
                },
            );
        }
    });
}

/// Whether the streaming sidecar binary exists for the selected compute
/// variant. Lets the frontend auto-detect and fall back to the chunked path.
#[tauri::command]
pub fn is_streaming_sidecar_available(app: AppHandle, preference: Option<String>) -> bool {
    super::local_whisper::streaming_sidecar_available(&app, preference.as_deref())
}

/// Start a streaming session for `tier`; returns the session id.
#[tauri::command]
pub async fn start_streaming_session(
    app: AppHandle,
    state: State<'_, StreamingSidecarState>,
    tier: String,
    compute_preference: Option<String>,
) -> Result<u64, String> {
    let launch = resolve_streaming_sidecar_launch(&app, &tier, compute_preference.as_deref())?;
    state.start(&app, launch).await
}

/// Push a batch of f32 PCM samples to the active session (ignored if stale).
#[tauri::command]
pub async fn push_streaming_frames(
    state: State<'_, StreamingSidecarState>,
    session_id: u64,
    frames: Vec<f32>,
) -> Result<(), String> {
    state.push(session_id, &frames).await
}

/// Finalize the active session; the sidecar flushes and emits its final event.
#[tauri::command]
pub async fn finish_streaming_session(
    state: State<'_, StreamingSidecarState>,
    session_id: u64,
) -> Result<(), String> {
    state.finish(session_id).await
}

/// Terminate the active session (cancel / teardown).
#[tauri::command]
pub async fn stop_streaming_session(
    state: State<'_, StreamingSidecarState>,
    session_id: u64,
) -> Result<(), String> {
    state.stop(session_id).await;
    Ok(())
}

/// Best-effort terminate on shutdown. Call from `RunEvent::Exit`.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<StreamingSidecarState>() {
        state.stop_now();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;
    use tokio::sync::mpsc::UnboundedReceiver;

    fn test_dir(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("streaming-sidecar-tests")
            .join(format!("{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Fake sidecar: reads the length-prefixed f32 protocol and echoes the
    /// sample count it read into each partial. On the finalize marker (0) it
    /// prints a single final event and exits.
    fn write_fake_sidecar(dir: &Path) -> PathBuf {
        let script = dir.join("fake-streaming-sidecar.py");
        fs::write(
            &script,
            r#"#!/usr/bin/env python3
import struct
import sys

stdin = sys.stdin.buffer

def read_exact(n):
    buf = b""
    while len(buf) < n:
        chunk = stdin.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf

count = 0
while True:
    header = read_exact(4)
    if header is None:
        break
    (n,) = struct.unpack("<I", header)
    if n == 0:
        sys.stdout.write('{"type":"final","text":"final transcript"}\n')
        sys.stdout.flush()
        break
    payload = read_exact(n * 4)
    if payload is None:
        break
    count += 1
    sys.stdout.write('{"type":"partial","text":"partial %d samples %d"}\n' % (count, n))
    sys.stdout.flush()
"#,
        )
        .unwrap();
        make_executable(&script);
        script
    }

    /// Fake sidecar that writes a partial line in two stdout writes (no newline
    /// between them) to exercise the buffered line reader, plus a junk line.
    fn write_fragmenting_sidecar(dir: &Path) -> PathBuf {
        let script = dir.join("fake-fragmenting-sidecar.py");
        fs::write(
            &script,
            r#"#!/usr/bin/env python3
import struct
import sys
import time

stdin = sys.stdin.buffer

def read_exact(n):
    buf = b""
    while len(buf) < n:
        chunk = stdin.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf

while True:
    header = read_exact(4)
    if header is None:
        break
    (n,) = struct.unpack("<I", header)
    if n == 0:
        sys.stdout.write("this is not json\n")
        sys.stdout.flush()
        sys.stdout.write('{"type":"final",')
        sys.stdout.flush()
        time.sleep(0.02)
        sys.stdout.write('"text":"stitched final"}\n')
        sys.stdout.flush()
        break
    payload = read_exact(n * 4)
    if payload is None:
        break
    sys.stdout.write('{"type":"partial",')
    sys.stdout.flush()
    time.sleep(0.02)
    sys.stdout.write('"text":"stitched partial"}\n')
    sys.stdout.flush()
"#,
        )
        .unwrap();
        make_executable(&script);
        script
    }

    fn make_executable(script: &Path) {
        let mut perms = fs::metadata(script).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(script, perms).unwrap();
    }

    fn spawn_fake(script: &Path) -> (StreamingSession, UnboundedReceiver<StreamEvent>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut cmd = Command::new("python3");
        cmd.arg(script);
        let session = StreamingSession::spawn_command(cmd, tx).unwrap();
        (session, rx)
    }

    async fn recv(rx: &mut UnboundedReceiver<StreamEvent>) -> StreamEvent {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for stream event")
            .expect("stream channel closed")
    }

    #[tokio::test]
    async fn streams_partials_in_order_then_final() {
        let dir = test_dir("partials");
        let script = write_fake_sidecar(&dir);
        let (mut session, mut rx) = spawn_fake(&script);

        session.send_frames(&[0.1, 0.2, 0.3]).await.unwrap();
        let p1 = recv(&mut rx).await;
        assert_eq!(p1.kind, "partial");
        assert_eq!(p1.text, "partial 1 samples 3");

        session.send_frames(&[0.4, 0.5]).await.unwrap();
        let p2 = recv(&mut rx).await;
        assert_eq!(p2.text, "partial 2 samples 2");

        session.finish().await.unwrap();
        let fin = recv(&mut rx).await;
        assert_eq!(fin.kind, "final");
        assert_eq!(fin.text, "final transcript");

        session.stop().await;
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn empty_finalize_yields_only_final() {
        let dir = test_dir("empty");
        let script = write_fake_sidecar(&dir);
        let (mut session, mut rx) = spawn_fake(&script);

        session.finish().await.unwrap();
        let fin = recv(&mut rx).await;
        assert_eq!(fin.kind, "final");
        assert_eq!(fin.text, "final transcript");

        session.stop().await;
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn send_after_finish_is_noop() {
        let dir = test_dir("after-finish");
        let script = write_fake_sidecar(&dir);
        let (mut session, mut rx) = spawn_fake(&script);

        session.finish().await.unwrap();
        // Late flush must not error or produce another partial.
        session.send_frames(&[0.9, 0.9]).await.unwrap();
        let fin = recv(&mut rx).await;
        assert_eq!(fin.kind, "final");

        session.stop().await;
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn stop_terminates_and_ends_reader() {
        let dir = test_dir("stop");
        let script = write_fake_sidecar(&dir);
        let (mut session, mut rx) = spawn_fake(&script);

        session.send_frames(&[0.1]).await.unwrap();
        let _ = recv(&mut rx).await;
        session.stop().await;

        // Channel closes once the reader task is aborted / tx dropped.
        let closed = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("reader should end after stop");
        assert!(closed.is_none(), "no events should arrive after stop");

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn reassembles_fragmented_json_and_skips_junk() {
        let dir = test_dir("fragment");
        let script = write_fragmenting_sidecar(&dir);
        let (mut session, mut rx) = spawn_fake(&script);

        session.send_frames(&[0.1, 0.2]).await.unwrap();
        let p = recv(&mut rx).await;
        assert_eq!(p.kind, "partial");
        assert_eq!(p.text, "stitched partial");

        session.finish().await.unwrap();
        // The junk line is skipped; the split final line is reassembled.
        let fin = recv(&mut rx).await;
        assert_eq!(fin.kind, "final");
        assert_eq!(fin.text, "stitched final");

        session.stop().await;
        let _ = fs::remove_dir_all(&dir);
    }
}
