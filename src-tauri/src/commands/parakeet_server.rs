//! Persistent Parakeet sidecar.
//!
//! The one-shot `sherpa-onnx-offline` CLI reloads the ~650 MB Parakeet ONNX
//! bundle on every dictation, so model load dominated end-to-end latency
//! (measured: ~6-7 s wall for ~0.3 s of actual inference on a 4 s clip). The
//! sherpa-onnx runtime archive already ships `sherpa-onnx-offline-websocket-server`,
//! so we run that once with the model resident and send PCM over a loopback
//! websocket instead (measured: ~0.3-0.6 s per request once warm).
//!
//! Wire protocol (sherpa-onnx `offline-websocket-server-impl.cc`): binary
//! messages carrying `[i32 LE sample_rate][i32 LE byte_len][f32 LE samples…]`,
//! which may be split across several messages; the server replies with one
//! JSON text message containing `text`, and the client sends `"Done"` to close.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Manager};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

fn perf_enabled() -> bool {
    std::env::var("VERBATIM_PERF").ok().as_deref() == Some("1")
}

const READY_TIMEOUT: Duration = Duration::from_secs(120);
const READY_POLL: Duration = Duration::from_millis(100);
/// Keep the model resident for a long stretch: a cold reload costs seconds,
/// which is exactly the latency this module exists to remove.
const DEFAULT_IDLE: Duration = Duration::from_secs(30 * 60);
const IDLE_CHECK: Duration = Duration::from_secs(60);
/// Longest utterance the server accepts (seconds). The default (300 s) would
/// reject long dictations outright.
pub(crate) const MAX_UTTERANCE_SECS: u32 = 900;
/// Payload chunk size per websocket message (the server reassembles them).
const CHUNK_BYTES: usize = 1 << 20;
const SAMPLE_RATE: i32 = 16_000;

/// Everything needed to launch the resident server for one model variant.
#[derive(Clone)]
pub(crate) struct ParakeetServerLaunch {
    pub server_bin: PathBuf,
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub joiner: PathBuf,
    pub tokens: PathBuf,
    pub log_file: PathBuf,
    /// Cache key (variant tag); a different key respawns the server.
    pub key: String,
    pub threads: usize,
}

struct ServerHandle {
    child: Child,
    key: String,
    port: u16,
    last_used: Instant,
}

impl ServerHandle {
    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

pub struct ParakeetServerState {
    inner: Arc<Mutex<Option<ServerHandle>>>,
    /// Serializes spawns so a hotkey prewarm and a transcription can't both
    /// launch a server.
    starting: Arc<Mutex<()>>,
    idle: Duration,
    idle_check: Duration,
    ready_timeout: Duration,
}

impl Default for ParakeetServerState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            starting: Arc::new(Mutex::new(())),
            idle: DEFAULT_IDLE,
            idle_check: IDLE_CHECK,
            ready_timeout: READY_TIMEOUT,
        }
    }
}

impl ParakeetServerState {
    /// Ensure a warm server for `launch.key` is running; return its port.
    pub(crate) async fn ensure_launch(&self, launch: ParakeetServerLaunch) -> Result<u16, String> {
        if let Some(port) = self.live_port(&launch.key).await {
            return Ok(port);
        }
        let _starting = self.starting.lock().await;
        if let Some(port) = self.live_port(&launch.key).await {
            return Ok(port);
        }
        self.unload().await;

        let port = pick_free_port()?;
        let spawn_started = Instant::now();
        let mut cmd = Command::new(&launch.server_bin);
        cmd.arg(format!("--port={port}"))
            .arg(format!("--num-threads={}", launch.threads))
            .arg("--num-work-threads=1")
            .arg("--num-io-threads=1")
            .arg("--max-batch-size=1")
            .arg(format!("--max-utterance-length={MAX_UTTERANCE_SECS}"))
            .arg(format!("--encoder={}", launch.encoder.display()))
            .arg(format!("--decoder={}", launch.decoder.display()))
            .arg(format!("--joiner={}", launch.joiner.display()))
            .arg(format!("--tokens={}", launch.tokens.display()))
            .arg("--model-type=nemo_transducer")
            .arg(format!("--log-file={}", launch.log_file.display()));
        // The default log file is `./log.txt`; never depend on the app's cwd
        // being writable (it is `/` for a macOS bundle).
        if let Some(dir) = launch.log_file.parent() {
            cmd.current_dir(dir);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.kill_on_drop(true);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to start the Parakeet server: {e}"))?;

        if let Err(e) = wait_until_listening(&mut child, port, self.ready_timeout).await {
            let _ = child.start_kill();
            return Err(e);
        }
        if perf_enabled() {
            eprintln!(
                "[verbatim-perf] parakeet-server spawn_ms={} key={}",
                spawn_started.elapsed().as_millis(),
                launch.key
            );
        }
        let mut guard = self.inner.lock().await;
        *guard = Some(ServerHandle {
            child,
            key: launch.key,
            port,
            last_used: Instant::now(),
        });
        Ok(port)
    }

    async fn live_port(&self, key: &str) -> Option<u16> {
        let mut guard = self.inner.lock().await;
        let h = guard.as_mut()?;
        if h.key == key && h.is_alive() {
            h.last_used = Instant::now();
            return Some(h.port);
        }
        None
    }

    /// Kill the resident server (if any). The next request respawns it.
    pub(crate) async fn unload(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(mut h) = guard.take() {
            let _ = h.child.start_kill();
        }
    }

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
        });
    }
}

fn pick_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

/// The server only starts listening after the model has loaded, so a
/// successful TCP connect doubles as the "model is warm" signal.
async fn wait_until_listening(child: &mut Child, port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "Parakeet server exited during startup ({status})"
            ));
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("Parakeet server did not become ready in time".into());
        }
        tokio::time::sleep(READY_POLL).await;
    }
}

/// Generous per-request deadline: fixed overhead plus a multiple of the audio
/// length, so a wedged server can't hang a dictation forever.
pub(crate) fn request_timeout(samples: usize) -> Duration {
    let audio_secs = samples as u64 / SAMPLE_RATE as u64;
    Duration::from_secs(20 + audio_secs * 2)
}

/// Frame `pcm` for the sherpa-onnx offline websocket protocol.
fn encode_request(pcm: &[f32]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(8 + pcm.len() * 4);
    buf.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    buf.extend_from_slice(&((pcm.len() * 4) as i32).to_le_bytes());
    for s in pcm {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}

fn parse_result(json: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("invalid Parakeet server reply: {e}"))?;
    Ok(v.get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .trim()
        .to_string())
}

/// Recognize one utterance on a warm server.
pub(crate) async fn recognize(port: u16, pcm: &[f32], timeout: Duration) -> Result<String, String> {
    let request = encode_request(pcm);
    let work = async {
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
            .await
            .map_err(|e| format!("couldn't connect to the Parakeet server: {e}"))?;
        for chunk in request.chunks(CHUNK_BYTES) {
            ws.send(Message::Binary(chunk.to_vec().into()))
                .await
                .map_err(|e| format!("couldn't send audio to the Parakeet server: {e}"))?;
        }
        let reply = loop {
            match ws.next().await {
                Some(Ok(Message::Text(t))) => break t.to_string(),
                Some(Ok(Message::Close(frame))) => {
                    let reason = frame.map(|f| f.reason.to_string()).unwrap_or_default();
                    return Err(format!("Parakeet server closed the connection: {reason}"));
                }
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(format!("Parakeet server connection failed: {e}")),
                None => return Err("Parakeet server closed the connection".to_string()),
            }
        };
        let _ = ws.send(Message::Text("Done".into())).await;
        let _ = ws.close(None).await;
        parse_result(&reply)
    };
    tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| "Parakeet server request timed out".to_string())?
}

/// Start the idle-unload watcher. Call once from `setup`.
pub fn init(app: &AppHandle) {
    if let Some(state) = app.try_state::<ParakeetServerState>() {
        state.spawn_idle_watcher();
    }
}

/// Best-effort termination on shutdown. Call from `RunEvent::Exit`.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<ParakeetServerState>() {
        state.terminate_now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_header_carries_rate_and_length() {
        let buf = encode_request(&[0.5, -0.5, 0.25]);
        assert_eq!(i32::from_le_bytes(buf[0..4].try_into().unwrap()), 16_000);
        assert_eq!(i32::from_le_bytes(buf[4..8].try_into().unwrap()), 12);
        assert_eq!(buf.len(), 8 + 12);
        assert_eq!(f32::from_le_bytes(buf[8..12].try_into().unwrap()), 0.5);
    }

    #[test]
    fn parses_server_reply() {
        let reply = r#"{"lang": "", "text": " Hello there. ", "tokens": []}"#;
        assert_eq!(parse_result(reply).unwrap(), "Hello there.");
        assert_eq!(parse_result(r#"{"tokens": []}"#).unwrap(), "");
        assert!(parse_result("not json").is_err());
    }

    #[test]
    fn timeout_scales_with_audio() {
        assert_eq!(request_timeout(0), Duration::from_secs(20));
        assert_eq!(request_timeout(16_000 * 60), Duration::from_secs(140));
    }

    /// Exercises the real sherpa-onnx server end to end. Run with
    /// `VERBATIM_PARAKEET_SERVER=<bin> VERBATIM_PARAKEET_MODEL_DIR=<dir>
    /// cargo test parakeet_server -- --ignored`.
    #[tokio::test]
    #[ignore = "needs a sherpa-onnx runtime + Parakeet model on disk"]
    async fn real_server_round_trip() {
        let (Ok(bin), Ok(dir)) = (
            std::env::var("VERBATIM_PARAKEET_SERVER"),
            std::env::var("VERBATIM_PARAKEET_MODEL_DIR"),
        ) else {
            return;
        };
        let dir = PathBuf::from(dir);
        let state = ParakeetServerState::default();
        let launch = ParakeetServerLaunch {
            server_bin: bin.into(),
            encoder: dir.join("encoder.int8.onnx"),
            decoder: dir.join("decoder.int8.onnx"),
            joiner: dir.join("joiner.int8.onnx"),
            tokens: dir.join("tokens.txt"),
            log_file: std::env::temp_dir().join("verbatim-parakeet-test.log"),
            key: "v3".into(),
            threads: inference_threads_for_test(),
        };
        let port = state.ensure_launch(launch.clone()).await.unwrap();
        // Same key reuses the warm server.
        assert_eq!(state.ensure_launch(launch).await.unwrap(), port);
        // One second of silence plus a full multi-chunk payload both decode.
        let silence = vec![0.0f32; 16_000];
        assert!(recognize(port, &silence, request_timeout(silence.len())).await.is_ok());
        let long = vec![0.0f32; 16_000 * 20];
        assert!(recognize(port, &long, request_timeout(long.len())).await.is_ok());
        if let Ok(wav) = std::env::var("VERBATIM_PARAKEET_WAV_PCM") {
            let bytes = std::fs::read(wav).unwrap();
            let pcm = super::super::runtime_assets::pcm_from_le_bytes(&bytes).unwrap();
            let started = Instant::now();
            let text = recognize(port, &pcm, request_timeout(pcm.len())).await.unwrap();
            eprintln!("warm request {} ms -> {text}", started.elapsed().as_millis());
            assert!(!text.is_empty());
        }
        state.unload().await;
    }

    fn inference_threads_for_test() -> usize {
        super::super::runtime_assets::inference_threads()
    }
}
