//! Native audio capture (route 3B of docs/proposals/handy-adoption.md §Phase 3).
//!
//! Moves microphone capture out of the WebView into Rust using `cpal` for the
//! device stream and `rubato` to resample the device audio to 16 kHz mono f32
//! PCM — the format every on-device transcription engine consumes. Capture runs
//! on a dedicated worker thread that owns the (non-`Send`) `cpal::Stream`;
//! samples are accumulated into a shared buffer and returned on stop.
//!
//! Two commands are exposed:
//! - `start_native_capture` — open the input device and begin buffering audio,
//!   emitting throttled `native_audio:level` RMS events for the overlay meter
//!   and (when `stream_frames` is set) per-frame `native_audio:frame` events.
//! - `stop_native_capture` — stop the stream and return the recorded 16 kHz
//!   mono f32 PCM.
//!
//! This is a clean-room reimplementation of the Handy design; no code is copied.
//!
//! Frame-level streaming (route 3B follow-up, issue #23 / closed #35): when the
//! caller opts in via `stream_frames`, the capture worker resamples the live
//! device audio to 16 kHz mono and emits fixed-size 480-sample (~30 ms) f32
//! frames — the exact format the WebAudio `pcm-frame-processor` worklet posts —
//! so VAD silence-trim / auto-stop and live partials consume native frames
//! unchanged. Base64 encoding and IPC happen on a dedicated emitter thread
//! (never on the realtime audio callback). When `stream_frames` is false the
//! frame path is entirely inert, so behaviour is unchanged for callers that
//! don't need live frames.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use base64::Engine as _;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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

/// Bounded depth of the frame channel between the audio callback and the
/// emitter thread (~1 s of 30 ms frames). If the emitter ever falls behind,
/// `try_send` drops frames instead of blocking the realtime audio thread.
const FRAME_CHANNEL_DEPTH: usize = 32;

/// Level events are emitted at most this many times per second to avoid an
/// IPC storm while still driving a smooth meter.
const LEVEL_EMITS_PER_SEC: u32 = 20;

#[derive(Clone, Serialize)]
struct LevelPayload {
    /// Root-mean-square amplitude of the latest chunk, in [0, 1].
    rms: f32,
}

#[derive(Clone, Serialize)]
struct FramePayload {
    /// Base64 of `FRAME_SIZE` little-endian f32 samples (1920 bytes).
    data: String,
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

/// Encode a 16 kHz mono f32 frame as base64 of its little-endian bytes.
fn encode_frame(frame: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(frame.len() * 4);
    for &s in frame {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A live capture session: the worker thread owning the stream plus the shared
/// mono sample buffer and the native device sample rate.
struct CaptureSession {
    stop_tx: Sender<()>,
    join: JoinHandle<()>,
    /// Emitter thread that base64-encodes streamed frames off the audio thread.
    /// `None` when `stream_frames` was not requested.
    frame_join: Option<JoinHandle<()>>,
    buffer: Arc<Mutex<Vec<f32>>>,
    src_rate: u32,
}

/// Tauri managed state holding the current capture session (if any).
#[derive(Default)]
pub struct NativeCaptureState(Mutex<Option<CaptureSession>>);

/// Locate an input device by (case-insensitive) name, falling back to the
/// system default. Mirrors the webview device-selection setting: the frontend
/// resolves the stored `sw.mic.deviceId` to its label and passes it here.
fn find_input_device(host: &cpal::Host, name: Option<&str>) -> Option<cpal::Device> {
    if let Some(n) = name.filter(|n| !n.is_empty()) {
        let needle = n.to_lowercase();
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
/// f32, appending to `buffer`, and emitting throttled RMS level events. When
/// `frame_tx` is `Some`, each downmixed sample is also fed to a streaming
/// resampler and completed 480-sample frames are forwarded (non-blocking) to
/// the emitter thread.
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buffer: Arc<Mutex<Vec<f32>>>,
    app: AppHandle,
    frame_tx: Option<SyncSender<Vec<f32>>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let src_rate = config.sample_rate.0.max(1);
    // Emit a level event roughly every `src_rate / LEVEL_EMITS_PER_SEC` frames.
    let emit_every = (src_rate / LEVEL_EMITS_PER_SEC).max(1) as usize;

    // Per-callback mutable throttle/accumulator state (data callback is FnMut).
    let mut frames_since_emit = 0usize;
    let mut sum_sq = 0f64;
    let mut count = 0usize;

    // Streaming resampler state, only active when frame streaming is requested.
    let mut resampler = frame_tx.as_ref().map(|_| FrameResampler::new(src_rate));

    let err_fn = |err| eprintln!("[native_audio] stream error: {err}");

    let stream = device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mut buf = match buffer.lock() {
                    Ok(b) => b,
                    Err(_) => return,
                };
                // Downmix interleaved frames to a single mono channel.
                for frame in data.chunks(channels) {
                    let mut acc = 0f32;
                    for s in frame {
                        acc += f32::from_sample(*s);
                    }
                    let mono = acc / channels as f32;
                    buf.push(mono);

                    // Feed the live resampler; completed frames are handed to
                    // the emitter thread without ever blocking this callback.
                    if let (Some(rs), Some(tx)) = (resampler.as_mut(), frame_tx.as_ref()) {
                        rs.push(mono, |frame| {
                            let _ = tx.try_send(frame);
                        });
                    }

                    sum_sq += (mono as f64) * (mono as f64);
                    count += 1;
                    frames_since_emit += 1;
                    if frames_since_emit >= emit_every {
                        let rms = if count > 0 {
                            (sum_sq / count as f64).sqrt() as f32
                        } else {
                            0.0
                        };
                        let _ = app.emit(LEVEL_EVENT, LevelPayload { rms });
                        frames_since_emit = 0;
                        sum_sq = 0.0;
                        count = 0;
                    }
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("failed to build input stream: {e}"))?;
    Ok(stream)
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

/// Stop and tear down an existing session, discarding its buffer.
fn terminate_session(session: CaptureSession) {
    let _ = session.stop_tx.send(());
    let _ = session.join.join();
    if let Some(frame_join) = session.frame_join {
        let _ = frame_join.join();
    }
}

/// Begin native microphone capture. `device_name` is an optional device label
/// (matched case-insensitively); `None`/empty uses the system default.
/// `stream_frames` opts into per-frame `native_audio:frame` streaming for VAD /
/// live-partial parity; when `false` (the default) that path stays inert.
#[tauri::command]
pub fn start_native_capture(
    app: AppHandle,
    state: State<'_, NativeCaptureState>,
    device_name: Option<String>,
    stream_frames: Option<bool>,
) -> Result<(), String> {
    let stream_frames = stream_frames.unwrap_or(false);
    // Replace any stale session (e.g. a previous capture that was never stopped).
    {
        let mut guard = state.0.lock().map_err(|_| "capture state poisoned")?;
        if let Some(prev) = guard.take() {
            terminate_session(prev);
        }
    }

    let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (setup_tx, setup_rx) = mpsc::channel::<Result<u32, String>>();

    // Optional frame streaming: a bounded channel decouples the realtime audio
    // callback from base64 encoding + IPC, which run on the emitter thread.
    let (frame_tx, frame_join) = if stream_frames {
        let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(FRAME_CHANNEL_DEPTH);
        let app_emit = app.clone();
        let join = std::thread::spawn(move || {
            while let Ok(frame) = rx.recv() {
                let _ = app_emit.emit(FRAME_EVENT, FramePayload { data: encode_frame(&frame) });
            }
        });
        (Some(tx), Some(join))
    } else {
        (None, None)
    };

    let buffer_thread = buffer.clone();
    let stopped = Arc::new(AtomicBool::new(false));
    let stopped_thread = stopped.clone();

    // The cpal `Stream` is `!Send`, so it must be built, played, and dropped on
    // the same thread. This worker owns it for the session's lifetime.
    let join = std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = match find_input_device(&host, device_name.as_deref()) {
            Some(d) => d,
            None => {
                let _ = setup_tx.send(Err("no input device available".into()));
                return;
            }
        };
        let supported = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                let _ = setup_tx.send(Err(format!("no default input config: {e}")));
                return;
            }
        };
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let src_rate = config.sample_rate.0;

        let built = match sample_format {
            cpal::SampleFormat::F32 => build_stream::<f32>(
                &device,
                &config,
                buffer_thread.clone(),
                app.clone(),
                frame_tx.clone(),
            ),
            cpal::SampleFormat::I16 => build_stream::<i16>(
                &device,
                &config,
                buffer_thread.clone(),
                app.clone(),
                frame_tx.clone(),
            ),
            cpal::SampleFormat::U16 => build_stream::<u16>(
                &device,
                &config,
                buffer_thread.clone(),
                app.clone(),
                frame_tx.clone(),
            ),
            other => Err(format!("unsupported sample format: {other:?}")),
        };
        // Drop the worker's own sender clone so the emitter thread ends once
        // the stream (which holds the callback's clone) is dropped on stop.
        drop(frame_tx);
        let stream = match built {
            Ok(s) => s,
            Err(e) => {
                let _ = setup_tx.send(Err(e));
                return;
            }
        };
        if let Err(e) = stream.play() {
            let _ = setup_tx.send(Err(format!("failed to start stream: {e}")));
            return;
        }
        // Capture is live; report the native sample rate back to the command.
        let _ = setup_tx.send(Ok(src_rate));

        // Park until the stop signal, then drop the stream on this thread.
        let _ = stop_rx.recv();
        stopped_thread.store(true, Ordering::SeqCst);
        drop(stream);
    });

    match setup_rx.recv() {
        Ok(Ok(src_rate)) => {
            let mut guard = state.0.lock().map_err(|_| "capture state poisoned")?;
            *guard = Some(CaptureSession {
                stop_tx,
                join,
                frame_join,
                buffer,
                src_rate,
            });
            Ok(())
        }
        Ok(Err(e)) => {
            let _ = join.join();
            if let Some(fj) = frame_join {
                let _ = fj.join();
            }
            Err(e)
        }
        Err(_) => {
            let _ = join.join();
            if let Some(fj) = frame_join {
                let _ = fj.join();
            }
            Err("capture worker exited before startup".into())
        }
    }
}

/// Stop native capture and return the recorded 16 kHz mono f32 PCM.
#[tauri::command]
pub fn stop_native_capture(state: State<'_, NativeCaptureState>) -> Result<Vec<f32>, String> {
    let session = {
        let mut guard = state.0.lock().map_err(|_| "capture state poisoned")?;
        guard.take()
    };
    let session = match session {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };

    let _ = session.stop_tx.send(());
    let _ = session.join.join();
    if let Some(frame_join) = session.frame_join {
        let _ = frame_join.join();
    }

    let raw = {
        let buf = session.buffer.lock().map_err(|_| "sample buffer poisoned")?;
        buf.clone()
    };
    resample_to_16k(&raw, session.src_rate)
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
}
