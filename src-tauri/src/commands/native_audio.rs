//! Native warm audio capture for push-to-talk.
//!
//! A long-lived worker thread owns the non-`Send` `cpal::Stream`. The stream is
//! opened by `arm_native_capture`, kept warm according to the requested policy,
//! and recording start/stop are consumption markers over a mono ring buffer.
//! Compatibility shims keep the original `start_native_capture` /
//! `stop_native_capture` command pair working for the current TypeScript path.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine as _;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Target sample rate handed to the ASR engines.
const TARGET_SAMPLE_RATE: u32 = 16_000;

/// Samples per streamed frame: 30 ms at {@link TARGET_SAMPLE_RATE}. Matches the
/// WebAudio worklet (`public/worklets/pcm-frame-processor.js`) so downstream VAD
/// consumes native and WebAudio frames identically.
const FRAME_SIZE: usize = 480;

/// Event name for the throttled capture level (RMS) used by the overlay meter.
const LEVEL_EVENT: &str = "native_audio:level";

/// Event name for streamed per-frame 16 kHz mono f32 PCM (base64-encoded).
const FRAME_EVENT: &str = "native_audio:frame";

/// Bounded depth of the audio-event channel between the realtime callback and
/// the emitter thread. If IPC falls behind, `try_send` drops events instead of
/// blocking the callback.
const FRAME_CHANNEL_DEPTH: usize = 32;

/// Level events are emitted at most this many times per second to avoid an
/// IPC storm while still driving a smooth meter.
const LEVEL_EMITS_PER_SEC: u32 = 20;

/// Keep on-demand warm streams open briefly after the last session so repeated
/// dictations avoid reopen latency while the macOS mic indicator still drops.
const IDLE_DISARM_AFTER: Duration = Duration::from_secs(45);

/// Common-case recording length (seconds) the session buffer is pre-sized
/// for, so the realtime cpal callback's `Vec::push` rarely pays for growth
/// (issue #53, N4). Longer recordings still work — the `Vec` just grows
/// normally past this point, off the hot path.
const INITIAL_RECORDING_SECONDS: usize = 30;

/// Event name for a sanitized mid-session capture failure (issue #53, S2).
const ERROR_EVENT: &str = "native_audio:error";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LevelPayload {
    /// Monotonic native capture session id.
    session_id: u64,
    /// Root-mean-square amplitude of the latest chunk, in [0, 1].
    rms: f32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FramePayload {
    /// Monotonic native capture session id.
    session_id: u64,
    /// Base64 of `FRAME_SIZE` little-endian f32 samples (1920 bytes).
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload {
    /// The session active when the failure occurred, if any. Absent when the
    /// stream errors while idle (armed but no recording in progress).
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<u64>,
    /// Stable, short error code — never a raw OS/backend message on its own.
    code: &'static str,
    /// Short, sanitized diagnostic string. Never a path, device unique id,
    /// transcript, or raw audio.
    message: String,
    /// Whether the app can reasonably retry without user action. Always
    /// `false` today — no automatic stream recovery is implemented.
    recoverable: bool,
}

enum AudioEvent {
    Level { session_id: u64, rms: f32 },
    Frame { session_id: u64, frame: Vec<f32> },
    Error { session_id: Option<u64>, code: &'static str, message: String, recoverable: bool },
}

/// Streaming linear-interpolation resampler that converts a mono sample stream
/// at `src_rate` to fixed-size 16 kHz `FRAME_SIZE` frames. This mirrors the
/// WebAudio worklet's linear interpolation grid (outputs at 0, step, 2·step, …
/// in input-sample coordinates), but as a per-sample push API so it can run
/// inside the cpal callback without any per-callback buffer concatenation.
struct FrameResampler {
    /// Input samples consumed per output sample (`src_rate / 16000`).
    step: f64,
    /// Position of the next output sample relative to `prev`, in input samples.
    phase: f64,
    /// Previous input sample (left edge of the current interpolation interval).
    prev: f32,
    /// Whether `prev` has been primed by the first input sample.
    have_prev: bool,
    /// Accumulates interpolated 16 kHz samples until a full frame is ready.
    buf: Vec<f32>,
}

impl FrameResampler {
    fn new(src_rate: u32) -> Self {
        Self {
            step: src_rate.max(1) as f64 / TARGET_SAMPLE_RATE as f64,
            phase: 0.0,
            prev: 0.0,
            have_prev: false,
            buf: Vec::with_capacity(FRAME_SIZE),
        }
    }

    /// Feed one mono input sample, invoking `emit` with each completed frame.
    fn push<F: FnMut(Vec<f32>)>(&mut self, sample: f32, mut emit: F) {
        if !self.have_prev {
            self.prev = sample;
            self.have_prev = true;
            return;
        }
        while self.phase < 1.0 {
            let f = self.phase as f32;
            self.buf.push(self.prev * (1.0 - f) + sample * f);
            if self.buf.len() == FRAME_SIZE {
                emit(std::mem::replace(&mut self.buf, Vec::with_capacity(FRAME_SIZE)));
            }
            self.phase += self.step;
        }
        self.phase -= 1.0;
        self.prev = sample;
    }
}

struct LevelAccumulator {
    emit_every: usize,
    frames_since_emit: usize,
    sum_sq: f64,
    count: usize,
}

impl LevelAccumulator {
    fn new(src_rate: u32) -> Self {
        Self {
            emit_every: (src_rate.max(1) / LEVEL_EMITS_PER_SEC).max(1) as usize,
            frames_since_emit: 0,
            sum_sq: 0.0,
            count: 0,
        }
    }

    fn reset(&mut self) {
        self.frames_since_emit = 0;
        self.sum_sq = 0.0;
        self.count = 0;
    }

    fn push(&mut self, sample: f32) -> Option<f32> {
        self.sum_sq += (sample as f64) * (sample as f64);
        self.count += 1;
        self.frames_since_emit += 1;
        if self.frames_since_emit < self.emit_every {
            return None;
        }
        let rms = if self.count > 0 {
            (self.sum_sq / self.count as f64).sqrt() as f32
        } else {
            0.0
        };
        self.reset();
        Some(rms)
    }
}

struct SessionBuffer {
    samples: Vec<f32>,
    src_rate: u32,
}

struct SharedAudioState {
    ring: VecDeque<f32>,
    ring_capacity: usize,
    src_rate: u32,
    sessions: HashMap<u64, SessionBuffer>,
    active_session_id: Option<u64>,
    stream_frames: bool,
    frame_resampler: Option<FrameResampler>,
    level: LevelAccumulator,
}

impl SharedAudioState {
    fn new() -> Self {
        Self {
            ring: VecDeque::with_capacity(TARGET_SAMPLE_RATE as usize),
            ring_capacity: TARGET_SAMPLE_RATE as usize,
            src_rate: TARGET_SAMPLE_RATE,
            sessions: HashMap::new(),
            active_session_id: None,
            stream_frames: false,
            frame_resampler: None,
            level: LevelAccumulator::new(TARGET_SAMPLE_RATE),
        }
    }

    fn configure_stream(&mut self, src_rate: u32, stream_frames: bool) {
        let src_rate = src_rate.max(1);
        self.src_rate = src_rate;
        self.ring_capacity = src_rate as usize;
        self.ring.clear();
        self.stream_frames = stream_frames;
        self.frame_resampler = None;
        self.level = LevelAccumulator::new(src_rate);
    }

    fn set_stream_frames(&mut self, stream_frames: bool) {
        self.stream_frames = stream_frames;
        if !stream_frames {
            self.frame_resampler = None;
        } else if self.frame_resampler.is_none() {
            // The Rust-first PTT hot path (issue #53) arms *before* JS has
            // resolved the mode, so it always requests `stream_frames: false`
            // (it doesn't yet know whether live-partial/VAD auto-stop needs
            // frames). JS re-arms with the resolved value right after
            // adopting the session; wire the resampler on immediately for an
            // already-active session instead of waiting for the next
            // `start_session` (which would never come for an adopted
            // session that's already recording).
            if let Some(session_id) = self.active_session_id {
                if self.sessions.contains_key(&session_id) {
                    self.frame_resampler = Some(FrameResampler::new(self.src_rate));
                }
            }
        }
    }

    fn push_ring(&mut self, sample: f32) {
        if self.ring_capacity == 0 {
            return;
        }
        if self.ring.len() == self.ring_capacity {
            self.ring.pop_front();
        }
        self.ring.push_back(sample);
    }

    fn pre_roll_snapshot(&self, pre_roll_ms: u32) -> Vec<f32> {
        let clamped_ms = pre_roll_ms.min(500);
        if clamped_ms == 0 || self.ring.is_empty() {
            return Vec::new();
        }
        let requested = (self.src_rate as usize).saturating_mul(clamped_ms as usize) / 1000;
        let take = requested.min(self.ring.len());
        self.ring.iter().skip(self.ring.len() - take).copied().collect()
    }

    fn start_session(&mut self, session_id: u64, pre_roll_ms: u32) {
        // Only one session is ever live at a time; drop any prior buffers
        // (including a stopped-but-never-taken one) so they can't accumulate.
        self.active_session_id = None;
        self.sessions.clear();
        let mut samples = self.pre_roll_snapshot(pre_roll_ms);
        // N4: reserve enough capacity for a common-case recording up front so
        // the realtime callback's per-sample `push` below rarely triggers an
        // amortized-growth reallocation+copy. Recordings longer than
        // `INITIAL_RECORDING_SECONDS` still work; the `Vec` just grows
        // normally past this point.
        let initial_capacity = (self.src_rate as usize)
            .saturating_mul(INITIAL_RECORDING_SECONDS)
            .saturating_add(samples.len());
        if samples.capacity() < initial_capacity {
            samples.reserve(initial_capacity - samples.capacity());
        }
        self.sessions.insert(
            session_id,
            SessionBuffer {
                samples,
                src_rate: self.src_rate,
            },
        );
        self.active_session_id = Some(session_id);
        self.level = LevelAccumulator::new(self.src_rate);
        self.frame_resampler = self
            .stream_frames
            .then(|| FrameResampler::new(self.src_rate));
    }

    fn stop_session(&mut self, session_id: u64) {
        if self.active_session_id == Some(session_id) {
            self.active_session_id = None;
            self.frame_resampler = None;
            self.level.reset();
        }
    }

    fn cancel_session(&mut self, session_id: u64) {
        self.stop_session(session_id);
        self.sessions.remove(&session_id);
    }

    fn take_session(&mut self, session_id: u64) -> Option<SessionBuffer> {
        self.stop_session(session_id);
        self.sessions.remove(&session_id)
    }

    fn clear_live_state(&mut self) {
        self.active_session_id = None;
        self.frame_resampler = None;
        self.level.reset();
        self.ring.clear();
        // Reclaim any orphaned session buffers on disarm / idle-close.
        self.sessions.clear();
    }

    fn has_active_session(&self) -> bool {
        self.active_session_id.is_some()
    }
}

#[derive(Clone)]
struct EngineClient {
    tx: Sender<EngineCommand>,
    armed: Arc<AtomicBool>,
}

impl EngineClient {
    fn request<T>(&self, build: impl FnOnce(Sender<Result<T, String>>) -> EngineCommand) -> Result<T, String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .send(build(reply_tx))
            .map_err(|_| "native audio worker is not running".to_string())?;
        reply_rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .map_err(|_| "native audio worker timed out or exited before replying".to_string())?
    }
}

struct EngineWorker {
    client: EngineClient,
    join: Option<JoinHandle<()>>,
}

/// Config the Rust-first push-to-talk hot path (issue #53) needs to start
/// native capture synchronously, cached by `configure_native_ptt_hotpath`
/// whenever the frontend's recording-engine setting, pre-roll, or mic device
/// changes — never read or written at key-down time by the frontend.
#[derive(Clone, Default)]
struct PttArmConfig {
    /// Mirrors `isNativeCaptureEnabled()` (recording engine != "standard").
    /// The hot path never starts native capture when this is `false`, so
    /// Standard/WebAudio recording is completely untouched.
    enabled: bool,
    pre_roll_ms: u32,
    device_name: Option<String>,
    keep_warm: bool,
    stream_frames: bool,
}

/// Tracks a session the Rust-first hot path itself started, from key-down
/// until JS has taken (or cancelled) its buffer. Self-limiting: while a
/// stopped-but-not-yet-taken session is tracked, a new key-down declines to
/// start another one, because the engine only ever buffers a single session
/// (`start_session` drops any prior untaken buffer) — starting a second one
/// here would otherwise race JS's `take_native_recording` and silently drop
/// audio.
#[derive(Clone, Copy, Default)]
struct PttTracker {
    session_id: Option<u64>,
    stopped: bool,
}

/// Tauri managed state for the warm native capture engine.
#[derive(Default)]
pub struct NativeCaptureState {
    engine: Mutex<Option<EngineWorker>>,
    compat_session: Mutex<Option<u64>>,
    ptt_hotpath: Mutex<PttArmConfig>,
    ptt_tracker: Mutex<PttTracker>,
}

impl NativeCaptureState {
    fn client(&self, app: Option<&AppHandle>) -> Result<EngineClient, String> {
        let mut guard = self.engine.lock().map_err(|_| "capture state poisoned")?;
        if let Some(worker) = guard.as_ref() {
            return Ok(worker.client.clone());
        }
        let app = app.ok_or_else(|| "native audio engine has not been initialized".to_string())?;
        let worker = spawn_engine(app.clone());
        let client = worker.client.clone();
        *guard = Some(worker);
        Ok(client)
    }

    fn existing_client(&self) -> Option<EngineClient> {
        self.engine
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|worker| worker.client.clone()))
    }
}

impl Drop for NativeCaptureState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.engine.lock() {
            if let Some(mut worker) = guard.take() {
                let _ = worker.client.tx.send(EngineCommand::Shutdown);
                if let Some(join) = worker.join.take() {
                    let _ = join.join();
                }
            }
        }
    }
}

#[derive(Clone)]
struct ArmConfig {
    device_name: Option<String>,
    keep_warm: bool,
    stream_frames: bool,
}

enum EngineCommand {
    Arm {
        config: ArmConfig,
        reply: Sender<Result<(), String>>,
    },
    Disarm {
        reply: Sender<Result<(), String>>,
    },
    StartSession {
        pre_roll_ms: u32,
        reply: Sender<Result<u64, String>>,
    },
    StopSession {
        session_id: u64,
        reply: Sender<Result<(), String>>,
    },
    TakeSession {
        session_id: u64,
        reply: Sender<Result<Vec<f32>, String>>,
    },
    CancelSession {
        session_id: u64,
        reply: Sender<Result<(), String>>,
    },
    Shutdown,
}

struct CachedInputDevice {
    requested_key: String,
    device: cpal::Device,
    sample_format: cpal::SampleFormat,
    config: cpal::StreamConfig,
}

fn spawn_engine(app: AppHandle) -> EngineWorker {
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let (event_tx, event_rx) = mpsc::sync_channel::<AudioEvent>(FRAME_CHANNEL_DEPTH);
    let armed = Arc::new(AtomicBool::new(false));
    let armed_worker = armed.clone();

    let event_join = std::thread::spawn(move || {
        while let Ok(event) = event_rx.recv() {
            match event {
                AudioEvent::Level { session_id, rms } => {
                    let _ = app.emit(LEVEL_EVENT, LevelPayload { session_id, rms });
                }
                AudioEvent::Frame { session_id, frame } => {
                    let _ = app.emit(
                        FRAME_EVENT,
                        FramePayload {
                            session_id,
                            data: encode_frame(&frame),
                        },
                    );
                }
                AudioEvent::Error { session_id, code, message, recoverable } => {
                    let _ = app.emit(
                        ERROR_EVENT,
                        ErrorPayload { session_id, code, message, recoverable },
                    );
                }
            }
        }
    });

    let join = std::thread::spawn(move || worker_loop(cmd_rx, event_tx, armed_worker, event_join));
    EngineWorker {
        client: EngineClient { tx: cmd_tx, armed },
        join: Some(join),
    }
}

fn worker_loop(
    cmd_rx: mpsc::Receiver<EngineCommand>,
    event_tx: SyncSender<AudioEvent>,
    armed: Arc<AtomicBool>,
    event_join: JoinHandle<()>,
) {
    let host = cpal::default_host();
    let shared = Arc::new(Mutex::new(SharedAudioState::new()));
    let mut cached: Option<CachedInputDevice> = None;
    let mut stream: Option<cpal::Stream> = None;
    let mut open_key: Option<String> = None;
    let mut desired: Option<ArmConfig> = None;
    let mut next_session_id = 1u64;
    let mut idle_since: Option<Instant> = None;

    loop {
        match cmd_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(command) => match command {
                EngineCommand::Arm { config, reply } => {
                    let result = handle_arm(
                        &host,
                        &shared,
                        &event_tx,
                        &armed,
                        &mut cached,
                        &mut stream,
                        &mut open_key,
                        &config,
                    );
                    if result.is_ok() {
                        desired = Some(config.clone());
                        idle_since = idle_start_if_needed(&shared, config.keep_warm);
                    }
                    let _ = reply.send(result);
                }
                EngineCommand::Disarm { reply } => {
                    desired = None;
                    close_stream(&shared, &armed, &mut stream, &mut open_key);
                    idle_since = None;
                    let _ = reply.send(Ok(()));
                }
                EngineCommand::StartSession { pre_roll_ms, reply } => {
                    let result = (|| {
                        let config = desired
                            .clone()
                            .ok_or_else(|| "native capture is not armed".to_string())?;
                        if stream.is_none() {
                            handle_arm(
                                &host,
                                &shared,
                                &event_tx,
                                &armed,
                                &mut cached,
                                &mut stream,
                                &mut open_key,
                                &config,
                            )?;
                        }
                        let session_id = next_session_id;
                        next_session_id = next_session_id.saturating_add(1).max(1);
                        let mut state = shared.lock().map_err(|_| "audio state poisoned")?;
                        state.start_session(session_id, pre_roll_ms.min(500));
                        Ok(session_id)
                    })();
                    if result.is_ok() {
                        idle_since = None;
                    }
                    let _ = reply.send(result);
                }
                EngineCommand::StopSession { session_id, reply } => {
                    let result = shared
                        .lock()
                        .map_err(|_| "audio state poisoned".to_string())
                        .map(|mut state| state.stop_session(session_id));
                    if result.is_ok() {
                        let keep_warm = desired.as_ref().is_some_and(|config| config.keep_warm);
                        idle_since = idle_start_if_needed(&shared, keep_warm);
                    }
                    let _ = reply.send(result);
                }
                EngineCommand::TakeSession { session_id, reply } => {
                    let result = shared
                        .lock()
                        .map_err(|_| "audio state poisoned".to_string())
                        .map(|mut state| state.take_session(session_id))
                        .and_then(|session| match session {
                            Some(session) => resample_to_16k(&session.samples, session.src_rate),
                            None => Ok(Vec::new()),
                        });
                    let _ = reply.send(result);
                }
                EngineCommand::CancelSession { session_id, reply } => {
                    let result = shared
                        .lock()
                        .map_err(|_| "audio state poisoned".to_string())
                        .map(|mut state| state.cancel_session(session_id));
                    let _ = reply.send(result);
                }
                EngineCommand::Shutdown => {
                    close_stream(&shared, &armed, &mut stream, &mut open_key);
                    break;
                }
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let keep_warm = desired.as_ref().is_some_and(|config| config.keep_warm);
                if stream.is_some() && !keep_warm && !has_active_session(&shared) {
                    let since = idle_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= IDLE_DISARM_AFTER {
                        close_stream(&shared, &armed, &mut stream, &mut open_key);
                        idle_since = None;
                    }
                } else {
                    idle_since = None;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                close_stream(&shared, &armed, &mut stream, &mut open_key);
                break;
            }
        }
    }

    drop(event_tx);
    let _ = event_join.join();
}

fn handle_arm(
    host: &cpal::Host,
    shared: &Arc<Mutex<SharedAudioState>>,
    event_tx: &SyncSender<AudioEvent>,
    armed: &Arc<AtomicBool>,
    cached: &mut Option<CachedInputDevice>,
    stream: &mut Option<cpal::Stream>,
    open_key: &mut Option<String>,
    config: &ArmConfig,
) -> Result<(), String> {
    let requested_key = normalize_device_key(config.device_name.as_deref());
    {
        let mut state = shared.lock().map_err(|_| "audio state poisoned")?;
        if state.has_active_session() && stream.is_some() && open_key.as_deref() != Some(&requested_key) {
            return Err("cannot switch native input device while a session is active".into());
        }
        // Only apply the (side-effecting) stream_frames change once we know the
        // arm request will be honored.
        state.set_stream_frames(config.stream_frames);
    }

    if stream.is_some() && open_key.as_deref() == Some(&requested_key) {
        return Ok(());
    }

    close_stream(shared, armed, stream, open_key);
    let cached_device = ensure_cached_device(host, cached, config.device_name.as_deref())?;
    let src_rate = cached_device.config.sample_rate.0.max(1);
    {
        let mut state = shared.lock().map_err(|_| "audio state poisoned")?;
        state.configure_stream(src_rate, config.stream_frames);
    }

    let built = match cached_device.sample_format {
        cpal::SampleFormat::F32 => build_stream::<f32>(
            &cached_device.device,
            &cached_device.config,
            shared.clone(),
            event_tx.clone(),
        ),
        cpal::SampleFormat::I16 => build_stream::<i16>(
            &cached_device.device,
            &cached_device.config,
            shared.clone(),
            event_tx.clone(),
        ),
        cpal::SampleFormat::U16 => build_stream::<u16>(
            &cached_device.device,
            &cached_device.config,
            shared.clone(),
            event_tx.clone(),
        ),
        other => Err(format!("unsupported sample format: {other:?}")),
    }?;
    built
        .play()
        .map_err(|e| format!("failed to start stream: {e}"))?;
    *stream = Some(built);
    *open_key = Some(cached_device.requested_key.clone());
    armed.store(true, Ordering::SeqCst);
    Ok(())
}

fn close_stream(
    shared: &Arc<Mutex<SharedAudioState>>,
    armed: &Arc<AtomicBool>,
    stream: &mut Option<cpal::Stream>,
    open_key: &mut Option<String>,
) {
    stream.take();
    *open_key = None;
    armed.store(false, Ordering::SeqCst);
    if let Ok(mut state) = shared.lock() {
        state.clear_live_state();
    }
}

fn idle_start_if_needed(shared: &Arc<Mutex<SharedAudioState>>, keep_warm: bool) -> Option<Instant> {
    if keep_warm || has_active_session(shared) {
        None
    } else {
        Some(Instant::now())
    }
}

fn has_active_session(shared: &Arc<Mutex<SharedAudioState>>) -> bool {
    shared
        .lock()
        .map(|state| state.has_active_session())
        .unwrap_or(false)
}

fn normalize_device_key(name: Option<&str>) -> String {
    name.and_then(|n| {
        let trimmed = n.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_lowercase())
    })
    .unwrap_or_else(|| "__default__".to_string())
}

fn ensure_cached_device<'a>(
    host: &cpal::Host,
    cached: &'a mut Option<CachedInputDevice>,
    name: Option<&str>,
) -> Result<&'a CachedInputDevice, String> {
    let requested_key = normalize_device_key(name);
    let needs_refresh = cached
        .as_ref()
        .map(|cached| cached.requested_key != requested_key)
        .unwrap_or(true);
    if needs_refresh {
        let device = find_input_device(host, name).ok_or_else(|| "no input device available".to_string())?;
        let supported = device
            .default_input_config()
            .map_err(|e| format!("no default input config: {e}"))?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        *cached = Some(CachedInputDevice {
            requested_key,
            device,
            sample_format,
            config,
        });
    }
    cached
        .as_ref()
        .ok_or_else(|| "failed to cache input device".to_string())
}

/// Locate an input device by (case-insensitive) name, falling back to the
/// system default. Mirrors the webview device-selection setting: the frontend
/// resolves the stored `sw.mic.deviceId` to its label and passes it here.
fn find_input_device(host: &cpal::Host, name: Option<&str>) -> Option<cpal::Device> {
    if let Some(n) = name.filter(|n| !n.trim().is_empty()) {
        let needle = n.trim().to_lowercase();
        if let Ok(devices) = host.input_devices() {
            for d in devices {
                if let Ok(dn) = d.name() {
                    let dn_l = dn.to_lowercase();
                    if dn_l == needle || dn_l.contains(&needle) {
                        return Some(d);
                    }
                }
            }
        }
    }
    host.default_input_device()
}

/// Build the input stream for a concrete sample format `T`, downmixing to mono
/// f32, maintaining the warm ring buffer, and appending live samples to the
/// active session only. Level and frame events are sent through a bounded
/// channel so the realtime callback never performs IPC or blocks on emission.
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    shared: Arc<Mutex<SharedAudioState>>,
    event_tx: SyncSender<AudioEvent>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let err_shared = shared.clone();
    let err_event_tx = event_tx.clone();
    let err_fn = move |err: cpal::StreamError| {
        eprintln!("[native_audio] stream error: {err}");
        // Mid-session device loss / stream failure (issue #53, S2). Correlate
        // to the active session if there is one so the overlay can react;
        // the message is sanitized so no path, device unique id, or other
        // backend-internal detail leaks to the frontend/logs.
        let session_id = err_shared.lock().ok().and_then(|s| s.active_session_id);
        let _ = err_event_tx.try_send(AudioEvent::Error {
            session_id,
            code: classify_stream_error(&err),
            message: sanitize_stream_error_message(&err),
            recoverable: false,
        });
    };

    let stream = device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mut state = match shared.lock() {
                    Ok(state) => state,
                    Err(_) => return,
                };
                for frame in data.chunks(channels) {
                    let mut acc = 0f32;
                    for s in frame {
                        acc += f32::from_sample(*s);
                    }
                    let mono = acc / channels as f32;
                    state.push_ring(mono);

                    let Some(session_id) = state.active_session_id else {
                        continue;
                    };
                    if let Some(session) = state.sessions.get_mut(&session_id) {
                        session.samples.push(mono);
                    }
                    if let Some(rms) = state.level.push(mono) {
                        let _ = event_tx.try_send(AudioEvent::Level { session_id, rms });
                    }
                    if let Some(rs) = state.frame_resampler.as_mut() {
                        rs.push(mono, |frame| {
                            let _ = event_tx.try_send(AudioEvent::Frame { session_id, frame });
                        });
                    }
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("failed to build input stream: {e}"))?;
    Ok(stream)
}

/// Stable, short code for a cpal stream error (issue #53, S2). Never
/// includes device names/ids or raw backend text — that goes in `message`,
/// separately sanitized by `sanitize_stream_error_message`.
fn classify_stream_error(err: &cpal::StreamError) -> &'static str {
    match err {
        cpal::StreamError::DeviceNotAvailable => "device_lost",
        cpal::StreamError::BackendSpecific { .. } => "stream_error",
    }
}

/// Longest `message` sent in a `native_audio:error` event. Backend-specific
/// error text is bounded defensively even though cpal's own messages are
/// short diagnostics, not user data.
const MAX_ERROR_MESSAGE_LEN: usize = 200;

/// Render a short, sanitized diagnostic for `native_audio:error`. Never
/// includes filesystem paths, device unique ids, env vars, transcripts, or
/// raw audio — cpal's `StreamError` never carries any of those, but the
/// backend-specific text is still length-bounded defensively.
fn sanitize_stream_error_message(err: &cpal::StreamError) -> String {
    match err {
        cpal::StreamError::DeviceNotAvailable => {
            "The input device is no longer available.".to_string()
        }
        cpal::StreamError::BackendSpecific { .. } => {
            let raw = err.to_string();
            if raw.len() <= MAX_ERROR_MESSAGE_LEN {
                raw
            } else {
                // Truncate on a char boundary so a multi-byte UTF-8 sequence
                // is never split.
                let mut end = MAX_ERROR_MESSAGE_LEN;
                while !raw.is_char_boundary(end) {
                    end -= 1;
                }
                format!("{}…", &raw[..end])
            }
        }
    }
}

/// Encode a 16 kHz mono f32 frame as base64 of its little-endian bytes.
fn encode_frame(frame: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(frame.len() * 4);
    for &s in frame {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Resample mono f32 `input` from `src_rate` to {@link TARGET_SAMPLE_RATE}.
/// A no-op (clone) when already at the target rate.
fn resample_to_16k(input: &[f32], src_rate: u32) -> Result<Vec<f32>, String> {
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
    };

    if src_rate == TARGET_SAMPLE_RATE {
        return Ok(input.to_vec());
    }
    if input.is_empty() {
        return Ok(Vec::new());
    }

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        oversampling_factor: 256,
        interpolation: SincInterpolationType::Linear,
        window: WindowFunction::BlackmanHarris2,
    };
    let chunk = 1024usize;
    let mut resampler = SincFixedIn::<f32>::new(
        TARGET_SAMPLE_RATE as f64 / src_rate as f64,
        2.0,
        params,
        chunk,
        1,
    )
    .map_err(|e| format!("resampler init failed: {e}"))?;

    let need = resampler.input_frames_next();
    let mut inbuf = vec![vec![0f32; need]];
    let approx_out = (input.len() as u64 * TARGET_SAMPLE_RATE as u64 / src_rate as u64) as usize;
    let mut out = Vec::with_capacity(approx_out + need);

    let mut pos = 0usize;
    while pos < input.len() {
        let take = (input.len() - pos).min(need);
        inbuf[0][..take].copy_from_slice(&input[pos..pos + take]);
        for s in inbuf[0][take..].iter_mut() {
            *s = 0.0;
        }
        let res = resampler
            .process(&inbuf, None)
            .map_err(|e| format!("resample failed: {e}"))?;
        out.extend_from_slice(&res[0]);
        pos += need;
    }

    // Keep only the samples that correspond to the real (non-padded) input.
    if approx_out < out.len() {
        out.truncate(approx_out);
    }
    Ok(out)
}

/// Open and keep the native stream warm. `keep_warm = false` lets the worker
/// drop the stream after the idle timeout; `stream_frames` controls live frame
/// events for subsequently started sessions.
#[tauri::command]
pub fn arm_native_capture(
    app: AppHandle,
    state: State<'_, NativeCaptureState>,
    device_name: Option<String>,
    keep_warm: bool,
    stream_frames: bool,
) -> Result<(), String> {
    let client = state.client(Some(&app))?;
    client.request(|reply| EngineCommand::Arm {
        config: ArmConfig {
            device_name,
            keep_warm,
            stream_frames,
        },
        reply,
    })
}

/// Cache the config the Rust-first push-to-talk hot path (`notify_ptt_down`)
/// needs to start native capture synchronously from the hotkey tap / global
/// shortcut callback, before any JS runs. The frontend calls this whenever
/// the recording-engine setting, pre-roll, or mic device changes (from
/// inside `syncNativeCaptureArm`, mirroring `arm_native_capture`) — never at
/// key-down time.
#[tauri::command]
pub fn configure_native_ptt_hotpath(
    state: State<'_, NativeCaptureState>,
    enabled: bool,
    pre_roll_ms: u32,
    device_name: Option<String>,
    keep_warm: bool,
    stream_frames: bool,
) -> Result<(), String> {
    let mut cfg = state.ptt_hotpath.lock().map_err(|_| "capture state poisoned")?;
    *cfg = PttArmConfig {
        enabled,
        pre_roll_ms: pre_roll_ms.min(500),
        device_name,
        keep_warm,
        stream_frames,
    };
    Ok(())
}

/// Drop the warm stream and clear live capture markers. Stopped session buffers
/// that have not yet been taken are preserved.
#[tauri::command]
pub fn disarm_native_capture(state: State<'_, NativeCaptureState>) -> Result<(), String> {
    match state.existing_client() {
        Some(client) => client.request(|reply| EngineCommand::Disarm { reply }),
        None => Ok(()),
    }
}

/// Start a new native recording session and return its monotonic session id.
/// `pre_roll_ms` is clamped to 0..=500 ms inside Rust.
#[tauri::command]
pub fn start_native_session(
    state: State<'_, NativeCaptureState>,
    pre_roll_ms: u32,
) -> Result<u64, String> {
    let client = state.client(None)?;
    client.request(|reply| EngineCommand::StartSession { pre_roll_ms, reply })
}

/// Mark a native recording session inactive while keeping its buffer available
/// for `take_native_recording`.
#[tauri::command]
pub fn stop_native_session(
    state: State<'_, NativeCaptureState>,
    session_id: u64,
) -> Result<(), String> {
    match state.existing_client() {
        Some(client) => client.request(|reply| EngineCommand::StopSession { session_id, reply }),
        None => Ok(()),
    }
}

/// Return 16 kHz mono f32 PCM for a stopped session, then drop its buffer.
#[tauri::command]
pub fn take_native_recording(
    state: State<'_, NativeCaptureState>,
    session_id: u64,
) -> Result<Vec<f32>, String> {
    let result = match state.existing_client() {
        Some(client) => client.request(|reply| EngineCommand::TakeSession { session_id, reply }),
        None => Ok(Vec::new()),
    };
    // JS has now taken this session's buffer — the hot path is free to start
    // a fresh one on the next key-down instead of permanently declining.
    clear_ptt_tracker_if(state.inner(), session_id);
    result
}

/// Drop a session buffer without returning audio.
#[tauri::command]
pub fn cancel_native_session(
    state: State<'_, NativeCaptureState>,
    session_id: u64,
) -> Result<(), String> {
    let result = match state.existing_client() {
        Some(client) => client.request(|reply| EngineCommand::CancelSession { session_id, reply }),
        None => Ok(()),
    };
    clear_ptt_tracker_if(state.inner(), session_id);
    result
}

/// Whether the native stream is currently open (and therefore the OS mic
/// indicator should be on).
#[tauri::command]
pub fn is_native_capture_armed(state: State<'_, NativeCaptureState>) -> bool {
    state
        .existing_client()
        .map(|client| client.armed.load(Ordering::SeqCst))
        .unwrap_or(false)
}

// ── Rust-first push-to-talk hot path (issue #53) ────────────────────────────
//
// `notify_ptt_down` / `notify_ptt_up` are plain functions (NOT tauri
// commands) meant to be called directly from the `fn`/Right-⌘ CGEventTap
// callback (commands/fn_hotkey.rs) and the global-shortcut handler
// (commands/hotkey.rs), *before* either emits `hotkey:down` / `hotkey:up`.
// They talk to the SAME warm-engine worker thread the tauri commands above
// use — a fast local mpsc round-trip, never the realtime cpal callback —
// so calling them from a dedicated OS event-tap thread is safe and matches
// the existing command pattern exactly.
//
// Both are infallible from the caller's point of view: every failure or
// "does not apply" case collapses to `started: false` / `stopped: false` so
// the caller can unconditionally fall back to the existing JS-orchestrated
// start/stop path, which already handles Standard/WebAudio and native-start
// failures.

/// Outcome of the Rust-first push-to-talk hot path on key-down.
#[derive(Clone, Copy)]
pub struct PttStartOutcome {
    /// The native session id, when the hot path started (or re-adopted) one.
    pub session_id: Option<u64>,
    /// Whether *this* call resulted in an active native session. When
    /// `false`, the existing JS-orchestrated start path should run exactly
    /// as it does today.
    pub started: bool,
}

/// Outcome of the Rust-first push-to-talk hot path on key-up.
#[derive(Clone, Copy)]
pub struct PttStopOutcome {
    /// The hot-path-tracked session id, if any (regardless of whether the
    /// stop itself succeeded).
    pub session_id: Option<u64>,
    /// Whether the native engine confirmed the session is now inactive.
    pub stopped: bool,
}

/// Pure decision for `notify_ptt_down`, given the current tracker + config.
/// Separated out so the interesting logic (duplicate-down adoption, the
/// self-limiting decline while a previous session is un-taken, and the
/// enabled/disabled gate) is unit-testable without a live `AppHandle`.
enum PttDownDecision {
    /// Re-adopt an already-active hot-path session (duplicate key-down).
    Adopt { session_id: u64 },
    /// Start a brand new native session.
    Start,
    /// Do nothing; the existing JS-orchestrated path should run instead.
    Decline,
}

fn decide_ptt_down(tracker: PttTracker, cfg: &PttArmConfig) -> PttDownDecision {
    if let Some(session_id) = tracker.session_id {
        if !tracker.stopped {
            // Auto-repeat / re-press while still held: same session, not a
            // new one.
            return PttDownDecision::Adopt { session_id };
        }
        // A previous hot-path session was stopped but JS hasn't taken (or
        // cancelled) its buffer yet. The engine only ever buffers one
        // session — starting another here would race JS's
        // `take_native_recording` and silently drop audio. Decline; the
        // existing JS-orchestrated path is no worse off than it is today.
        return PttDownDecision::Decline;
    }
    if !cfg.enabled {
        return PttDownDecision::Decline;
    }
    PttDownDecision::Start
}

/// Clear the push-to-talk tracker once JS has actually consumed (or
/// discarded) the session, so a subsequent `notify_ptt_down` is free to
/// start fresh instead of permanently declining after one hot-path session.
fn clear_ptt_tracker_if(state: &NativeCaptureState, session_id: u64) {
    if let Ok(mut tracker) = state.ptt_tracker.lock() {
        if tracker.session_id == Some(session_id) {
            *tracker = PttTracker::default();
        }
    }
}

/// Rust-first push-to-talk hot path: call directly from the `fn` /
/// Right-⌘ CGEventTap callback and the global-shortcut handler, *before*
/// emitting `hotkey:down`, so native Fast/Instant capture starts without any
/// JS/webview round trip. Never blocks on JS, network, active-window lookup,
/// or the realtime audio callback, and never panics.
pub fn notify_ptt_down(app: &AppHandle) -> PttStartOutcome {
    const DECLINE: PttStartOutcome = PttStartOutcome { session_id: None, started: false };

    let Some(state) = app.try_state::<NativeCaptureState>() else {
        return DECLINE;
    };
    let tracker = state.ptt_tracker.lock().map(|g| *g).unwrap_or_default();
    let cfg = match state.ptt_hotpath.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return DECLINE,
    };

    match decide_ptt_down(tracker, &cfg) {
        PttDownDecision::Adopt { session_id } => {
            PttStartOutcome { session_id: Some(session_id), started: true }
        }
        PttDownDecision::Decline => DECLINE,
        PttDownDecision::Start => {
            let client = match state.client(Some(app)) {
                Ok(client) => client,
                Err(_) => return DECLINE,
            };
            // Seed/refresh the engine's arm config so a fully cold engine
            // (never armed via the JS settings-sync path) can self-arm here
            // too. Cheap no-op when the requested device is already open.
            let armed = client.request(|reply| EngineCommand::Arm {
                config: ArmConfig {
                    device_name: cfg.device_name.clone(),
                    keep_warm: cfg.keep_warm,
                    stream_frames: cfg.stream_frames,
                },
                reply,
            });
            if armed.is_err() {
                return DECLINE;
            }
            match client.request(|reply| EngineCommand::StartSession {
                pre_roll_ms: cfg.pre_roll_ms,
                reply,
            }) {
                Ok(session_id) => {
                    if let Ok(mut t) = state.ptt_tracker.lock() {
                        *t = PttTracker { session_id: Some(session_id), stopped: false };
                    }
                    PttStartOutcome { session_id: Some(session_id), started: true }
                }
                Err(_) => DECLINE,
            }
        }
    }
}

/// Rust-first push-to-talk hot path counterpart for key-up: marks the
/// hot-path-started session inactive (if any) so the realtime callback stops
/// appending samples immediately, without waiting for JS. The buffered PCM
/// is left in place for the existing `take_native_recording` command.
pub fn notify_ptt_up(app: &AppHandle) -> PttStopOutcome {
    let Some(state) = app.try_state::<NativeCaptureState>() else {
        return PttStopOutcome { session_id: None, stopped: false };
    };
    let session_id = state.ptt_tracker.lock().ok().and_then(|t| t.session_id);
    let Some(session_id) = session_id else {
        return PttStopOutcome { session_id: None, stopped: false };
    };
    let Some(client) = state.existing_client() else {
        return PttStopOutcome { session_id: Some(session_id), stopped: false };
    };
    let stopped = client
        .request(|reply| EngineCommand::StopSession { session_id, reply })
        .is_ok();
    if stopped {
        if let Ok(mut tracker) = state.ptt_tracker.lock() {
            if tracker.session_id == Some(session_id) {
                tracker.stopped = true;
            }
        }
    }
    PttStopOutcome { session_id: Some(session_id), stopped }
}

/// Backward-compatible shim: open/arm the warm engine and immediately start a
/// zero-pre-roll session. The current TypeScript consumer can keep invoking the
/// original command unchanged.
#[tauri::command]
pub fn start_native_capture(
    app: AppHandle,
    state: State<'_, NativeCaptureState>,
    device_name: Option<String>,
    stream_frames: Option<bool>,
) -> Result<(), String> {
    let client = state.client(Some(&app))?;
    if let Some(old_session_id) = state
        .compat_session
        .lock()
        .map_err(|_| "compat capture state poisoned")?
        .take()
    {
        let _ = client.request(|reply| EngineCommand::StopSession {
            session_id: old_session_id,
            reply,
        });
        let _ = client.request(|reply| EngineCommand::CancelSession {
            session_id: old_session_id,
            reply,
        });
    }

    client.request(|reply| EngineCommand::Arm {
        config: ArmConfig {
            device_name,
            keep_warm: false,
            stream_frames: stream_frames.unwrap_or(false),
        },
        reply,
    })?;
    let session_id = match client.request(|reply| EngineCommand::StartSession {
        pre_roll_ms: 0,
        reply,
    }) {
        Ok(id) => id,
        Err(e) => {
            // Don't leave the mic warm (indicator lit) after a failed start.
            let _ = client.request(|reply| EngineCommand::Disarm { reply });
            return Err(e);
        }
    };
    *state
        .compat_session
        .lock()
        .map_err(|_| "compat capture state poisoned")? = Some(session_id);
    Ok(())
}

/// Backward-compatible shim: stop the active compat session, take its 16 kHz
/// PCM, and disarm the stream to match the previous open-on-start/close-on-stop
/// lifecycle.
#[tauri::command]
pub fn stop_native_capture(state: State<'_, NativeCaptureState>) -> Result<Vec<f32>, String> {
    let client = match state.existing_client() {
        Some(client) => client,
        None => return Ok(Vec::new()),
    };
    let session_id = match state
        .compat_session
        .lock()
        .map_err(|_| "compat capture state poisoned")?
        .take()
    {
        Some(session_id) => session_id,
        None => return Ok(Vec::new()),
    };

    client.request(|reply| EngineCommand::StopSession { session_id, reply })?;
    let audio = client.request(|reply| EngineCommand::TakeSession { session_id, reply });
    let _ = client.request(|reply| EngineCommand::Disarm { reply });
    audio
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_passthrough_when_already_16k() {
        let input: Vec<f32> = (0..1000).map(|i| (i as f32).sin()).collect();
        let out = resample_to_16k(&input, TARGET_SAMPLE_RATE).unwrap();
        assert_eq!(out, input);
    }

    #[test]
    fn resample_empty_is_empty() {
        let out = resample_to_16k(&[], 48_000).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn resample_downsamples_to_expected_length() {
        // 1 second of 48 kHz audio should become ~1 second at 16 kHz.
        let src_rate = 48_000u32;
        let input: Vec<f32> = (0..src_rate)
            .map(|i| ((i as f32) * 0.01).sin() * 0.5)
            .collect();
        let out = resample_to_16k(&input, src_rate).unwrap();
        let expected = input.len() as u64 * TARGET_SAMPLE_RATE as u64 / src_rate as u64;
        let diff = (out.len() as i64 - expected as i64).abs();
        // Allow a small slop for the fixed-chunk padding at the tail.
        assert!(
            diff <= 1024,
            "resampled length {} too far from expected {expected}",
            out.len()
        );
    }

    /// Drive `n` samples through a `FrameResampler` and collect emitted frames.
    fn collect_frames(src_rate: u32, n: usize) -> Vec<Vec<f32>> {
        let mut rs = FrameResampler::new(src_rate);
        let mut frames = Vec::new();
        for i in 0..n {
            let s = ((i as f32) * 0.05).sin() * 0.5;
            rs.push(s, |frame| frames.push(frame));
        }
        frames
    }

    #[test]
    fn frame_resampler_emits_fixed_size_frames() {
        let frames = collect_frames(16_000, FRAME_SIZE * 10 + 37);
        assert!(!frames.is_empty());
        for f in &frames {
            assert_eq!(f.len(), FRAME_SIZE, "every emitted frame must be 480 samples");
        }
    }

    #[test]
    fn frame_resampler_passthrough_count_at_16k() {
        // At 16 kHz (step == 1) one output is produced per input after the
        // first priming sample, so N inputs yield floor((N-1)/480) frames.
        let n = FRAME_SIZE * 5 + 100;
        let frames = collect_frames(16_000, n);
        assert_eq!(frames.len(), (n - 1) / FRAME_SIZE);
    }

    #[test]
    fn frame_resampler_downsamples_frame_count() {
        // 48 kHz → 16 kHz decimates ~3:1, so ~n/3 output samples.
        let n = 48_000usize; // 1 s at 48 kHz
        let frames = collect_frames(48_000, n);
        let out_samples = frames.len() * FRAME_SIZE;
        let expected = n / 3;
        // Within one frame of the expected ~16000 output samples.
        assert!(
            (out_samples as i64 - expected as i64).abs() <= FRAME_SIZE as i64,
            "downsampled output {out_samples} too far from expected {expected}"
        );
    }

    #[test]
    fn encode_frame_roundtrips_little_endian() {
        let frame = vec![0.0f32, 1.0, -0.5, 0.25, f32::from_bits(0x3f800001)];
        let encoded = encode_frame(&frame);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(bytes.len(), frame.len() * 4);
        let decoded: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        assert_eq!(decoded, frame);
    }

    // ── Rust-first push-to-talk hot path (issue #53) ────────────────────

    #[test]
    fn decide_ptt_down_declines_when_hotpath_disabled() {
        let cfg = PttArmConfig { enabled: false, ..Default::default() };
        match decide_ptt_down(PttTracker::default(), &cfg) {
            PttDownDecision::Decline => {}
            _ => panic!("expected Decline when the hot path is disabled"),
        }
    }

    #[test]
    fn decide_ptt_down_starts_when_enabled_and_no_tracked_session() {
        let cfg = PttArmConfig { enabled: true, ..Default::default() };
        match decide_ptt_down(PttTracker::default(), &cfg) {
            PttDownDecision::Start => {}
            _ => panic!("expected Start when enabled with no tracked session"),
        }
    }

    #[test]
    fn decide_ptt_down_readopts_duplicate_down_while_held() {
        let cfg = PttArmConfig { enabled: true, ..Default::default() };
        let tracker = PttTracker { session_id: Some(7), stopped: false };
        match decide_ptt_down(tracker, &cfg) {
            PttDownDecision::Adopt { session_id } => assert_eq!(session_id, 7),
            _ => panic!("expected Adopt for a duplicate down on an active session"),
        }
    }

    #[test]
    fn decide_ptt_down_declines_when_prior_session_not_yet_taken() {
        // Even with the hot path enabled, a stopped-but-untaken session must
        // block a new start so the engine's single-session buffer can't be
        // wiped out from under a pending `take_native_recording`.
        let cfg = PttArmConfig { enabled: true, ..Default::default() };
        let tracker = PttTracker { session_id: Some(3), stopped: true };
        match decide_ptt_down(tracker, &cfg) {
            PttDownDecision::Decline => {}
            _ => panic!("expected Decline while a stopped session is un-taken"),
        }
    }

    #[test]
    fn clear_ptt_tracker_if_only_clears_matching_session() {
        let state = NativeCaptureState::default();
        *state.ptt_tracker.lock().unwrap() = PttTracker { session_id: Some(5), stopped: true };
        clear_ptt_tracker_if(&state, 999); // different id: no-op
        assert_eq!(state.ptt_tracker.lock().unwrap().session_id, Some(5));
        clear_ptt_tracker_if(&state, 5);
        assert_eq!(state.ptt_tracker.lock().unwrap().session_id, None);
    }

    #[test]
    fn start_session_reserves_capacity_for_initial_recording_window() {
        let mut state = SharedAudioState::new();
        state.configure_stream(16_000, false);
        state.start_session(1, 0);
        let session = state.sessions.get(&1).expect("session must exist");
        let expected = 16_000usize * INITIAL_RECORDING_SECONDS;
        assert!(
            session.samples.capacity() >= expected,
            "capacity {} should cover at least {expected} samples up front",
            session.samples.capacity(),
        );
    }

    #[test]
    fn start_session_does_not_allocate_unbounded_capacity() {
        // Sanity bound so a future change can't accidentally balloon this
        // into a many-minute up-front allocation.
        let mut state = SharedAudioState::new();
        state.configure_stream(48_000, false);
        state.start_session(1, 500);
        let session = state.sessions.get(&1).unwrap();
        assert!(session.samples.capacity() < 48_000 * 60);
    }

    #[test]
    fn set_stream_frames_wires_resampler_onto_active_session_retroactively() {
        // The hot path arms with `stream_frames: false` (mode not resolved
        // yet); JS re-arms with the resolved value right after adopting an
        // already-active session. That must wire live frame streaming on
        // immediately rather than waiting for a `start_session` that will
        // never come for an adopted session.
        let mut state = SharedAudioState::new();
        state.configure_stream(16_000, false);
        state.start_session(1, 0);
        assert!(state.frame_resampler.is_none());
        state.set_stream_frames(true);
        assert!(state.frame_resampler.is_some());
    }

    #[test]
    fn set_stream_frames_disabling_clears_resampler() {
        let mut state = SharedAudioState::new();
        state.configure_stream(16_000, true);
        state.start_session(1, 0);
        assert!(state.frame_resampler.is_some());
        state.set_stream_frames(false);
        assert!(state.frame_resampler.is_none());
    }

    #[test]
    fn classify_stream_error_distinguishes_device_loss() {
        assert_eq!(
            classify_stream_error(&cpal::StreamError::DeviceNotAvailable),
            "device_lost"
        );
        let backend = cpal::StreamError::BackendSpecific {
            err: cpal::BackendSpecificError { description: "boom".to_string() },
        };
        assert_eq!(classify_stream_error(&backend), "stream_error");
    }

    #[test]
    fn sanitize_stream_error_message_is_fixed_for_device_loss() {
        let msg = sanitize_stream_error_message(&cpal::StreamError::DeviceNotAvailable);
        assert_eq!(msg, "The input device is no longer available.");
    }

    #[test]
    fn sanitize_stream_error_message_truncates_long_backend_text() {
        let long_description = "x".repeat(500);
        let err = cpal::StreamError::BackendSpecific {
            err: cpal::BackendSpecificError { description: long_description },
        };
        let msg = sanitize_stream_error_message(&err);
        assert!(msg.chars().count() <= MAX_ERROR_MESSAGE_LEN + 1); // +1 for the "…" marker
    }
}
