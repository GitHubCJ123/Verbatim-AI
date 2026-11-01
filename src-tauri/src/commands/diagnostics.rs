use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const SCHEMA_VERSION: u8 = 1;
const MAX_EVENTS: usize = 100;
const MAX_FILE_BYTES: u64 = 32 * 1024;
const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const STORAGE_ERROR: &str = "Local diagnostics are unavailable. Delete diagnostics to reset them. If deletion fails, they may resume after the app restarts.";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticKind {
    UncleanExit,
    MicrophoneStartFailed,
    MicrophoneCaptureFailed,
    SpeechModelMissing,
    TranscriptionFailed,
    PolishFailed,
    PasteTargetMissing,
    PastePermissionRequired,
    PasteActivationFailed,
    PasteDispatchFailed,
    ClipboardWriteFailed,
    DeliveryFailed,
    DeliveryConfirmationFailed,
    HistoryWriteFailed,
    HotkeyRegistrationFailed,
    MainWindowError,
    OverlayWindowError,
    MainUnhandledRejection,
    OverlayUnhandledRejection,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticStage {
    Capture,
    Transcription,
    Polish,
    Delivery,
    Review,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticEvent {
    recorded_at_ms: u64,
    kind: DiagnosticKind,
    app_version: [u64; 3],
    stage: Option<DiagnosticStage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    schema_version: u8,
    enabled: bool,
    running: bool,
    running_version: Option<[u64; 3]>,
    stage: Option<DiagnosticStage>,
    events: Vec<DiagnosticEvent>,
}

impl Default for Journal {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            enabled: false,
            running: false,
            running_version: None,
            stage: None,
            events: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticTrace {
    generation: u32,
    trace_id: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    enabled: bool,
    generation: u32,
    app_version: &'static str,
    platform: &'static str,
    architecture: &'static str,
    events: Vec<DiagnosticEvent>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPolicy {
    enabled: bool,
    generation: u32,
}

struct JournalManager {
    path: Option<PathBuf>,
    journal: Journal,
    generation: u32,
    next_trace_id: u32,
    active_trace: Option<DiagnosticTrace>,
    unavailable: bool,
}

pub struct DiagnosticsState(Mutex<JournalManager>);

fn app_version() -> [u64; 3] {
    [
        env!("CARGO_PKG_VERSION_MAJOR")
            .parse()
            .expect("valid major version"),
        env!("CARGO_PKG_VERSION_MINOR")
            .parse()
            .expect("valid minor version"),
        env!("CARGO_PKG_VERSION_PATCH")
            .parse()
            .expect("valid patch version"),
    ]
}

fn now_ms() -> Result<u64, String> {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| STORAGE_ERROR.to_owned())?
        .as_millis();
    u64::try_from(ms).map_err(|_| STORAGE_ERROR.to_owned())
}

fn temp_path(path: &Path) -> PathBuf {
    path.with_extension("tmp")
}

fn remove_if_present(path: &Path) -> Result<(), ()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err(()),
    }
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> Result<(), ()> {
    fs::rename(from, to).map_err(|_| ())
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> Result<(), ()> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        },
    };

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }
    let from = wide(from.as_os_str());
    let to = wide(to.as_os_str());
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|_| ())
}

fn write_journal(path: &Path, journal: &Journal) -> Result<(), ()> {
    let bytes = serde_json::to_vec(journal).map_err(|_| ())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(());
    }
    fs::create_dir_all(path.parent().ok_or(())?).map_err(|_| ())?;
    let temporary = temp_path(path);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|_| ())?;
    let written = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    if written.is_err() || replace_file(&temporary, path).is_err() {
        let _ = remove_if_present(&temporary);
        return Err(());
    }
    Ok(())
}

fn read_journal(path: &Path) -> Result<Option<Journal>, ()> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(());
    }
    let journal: Journal = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if journal.schema_version != SCHEMA_VERSION
        || journal.events.len() > MAX_EVENTS
        || (!journal.enabled
            && (journal.running
                || journal.running_version.is_some()
                || journal.stage.is_some()
                || !journal.events.is_empty()))
        || (journal.running != journal.running_version.is_some())
        || (!journal.running && journal.stage.is_some())
    {
        return Err(());
    }
    Ok(Some(journal))
}

fn prune(journal: &mut Journal, now: u64) -> bool {
    let previous = journal.events.len();
    journal
        .events
        .retain(|event| event.recorded_at_ms <= now && now - event.recorded_at_ms <= RETENTION_MS);
    previous != journal.events.len()
}

fn push_event(
    journal: &mut Journal,
    now: u64,
    kind: DiagnosticKind,
    version: [u64; 3],
    stage: Option<DiagnosticStage>,
) {
    prune(journal, now);
    if journal.events.len() == MAX_EVENTS {
        journal.events.remove(0);
    }
    journal.events.push(DiagnosticEvent {
        recorded_at_ms: now,
        kind,
        app_version: version,
        stage,
    });
}

impl JournalManager {
    fn unavailable(path: Option<PathBuf>) -> Self {
        Self {
            path,
            journal: Journal::default(),
            generation: 0,
            next_trace_id: 0,
            active_trace: None,
            unavailable: true,
        }
    }

    fn open(path: PathBuf, now: u64) -> Self {
        let mut manager = Self {
            path: Some(path.clone()),
            journal: Journal::default(),
            generation: 0,
            next_trace_id: 0,
            active_trace: None,
            unavailable: false,
        };
        let loaded = remove_if_present(&temp_path(&path)).and_then(|()| read_journal(&path));
        match loaded {
            Ok(Some(mut journal)) if journal.enabled => {
                if journal.running {
                    let version = journal.running_version.expect("validated running version");
                    let stage = journal.stage;
                    push_event(
                        &mut journal,
                        now,
                        DiagnosticKind::UncleanExit,
                        version,
                        stage,
                    );
                } else {
                    prune(&mut journal, now);
                }
                journal.running = true;
                journal.running_version = Some(app_version());
                journal.stage = None;
                if manager.persist(journal).is_err() {
                    return manager;
                }
            }
            Ok(Some(journal)) => manager.journal = journal,
            Ok(None) => {}
            Err(()) => manager.unavailable = true,
        }
        manager
    }

    fn fail(&mut self) -> String {
        self.unavailable = true;
        self.journal = Journal::default();
        self.active_trace = None;
        self.generation = self.generation.wrapping_add(1);
        STORAGE_ERROR.to_owned()
    }

    fn persist(&mut self, journal: Journal) -> Result<(), String> {
        let result = self
            .path
            .as_ref()
            .ok_or(())
            .and_then(|path| write_journal(path, &journal));
        if result.is_err() {
            return Err(self.fail());
        }
        self.journal = journal;
        Ok(())
    }

    fn prune_expired(&mut self, now: u64) -> Result<(), String> {
        if self.unavailable {
            return Err(STORAGE_ERROR.to_owned());
        }
        if self.journal.enabled {
            let mut next = self.journal.clone();
            if prune(&mut next, now) {
                self.persist(next)?;
            }
        }
        Ok(())
    }

    fn report(&mut self, now: u64) -> Result<DiagnosticReport, String> {
        self.prune_expired(now)?;
        Ok(DiagnosticReport {
            enabled: self.journal.enabled,
            generation: self.generation,
            app_version: env!("CARGO_PKG_VERSION"),
            platform: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            events: self.journal.events.clone(),
        })
    }

    fn policy(&self) -> DiagnosticPolicy {
        DiagnosticPolicy {
            enabled: self.journal.enabled && !self.unavailable,
            generation: self.generation,
        }
    }

    fn disable_and_delete(&mut self) -> Result<(), String> {
        self.journal = Journal::default();
        self.active_trace = None;
        self.generation = self.generation.wrapping_add(1);
        let result = self.path.as_ref().ok_or(()).and_then(|path| {
            remove_if_present(path)?;
            remove_if_present(&temp_path(path))
        });
        if result.is_err() {
            return Err(self.fail());
        }
        self.unavailable = false;
        Ok(())
    }

    fn set_enabled(&mut self, enabled: bool, now: u64) -> Result<DiagnosticReport, String> {
        if !enabled {
            self.disable_and_delete()?;
        } else {
            if self.unavailable {
                return Err(STORAGE_ERROR.to_owned());
            }
            if !self.journal.enabled {
                let next = Journal {
                    enabled: true,
                    running: true,
                    running_version: Some(app_version()),
                    ..Journal::default()
                };
                self.persist(next)?;
                self.generation = self.generation.wrapping_add(1);
            }
        }
        self.report(now)
    }

    fn record(&mut self, kind: DiagnosticKind, generation: u32, now: u64) -> Result<(), String> {
        if kind == DiagnosticKind::UncleanExit {
            return Err("Unclean exit is reserved for startup detection.".to_owned());
        }
        if self.unavailable {
            return Err(STORAGE_ERROR.to_owned());
        }
        if self.journal.enabled && self.generation == generation {
            let mut next = self.journal.clone();
            push_event(&mut next, now, kind, app_version(), None);
            self.persist(next)?;
        }
        Ok(())
    }

    fn begin_trace(
        &mut self,
        generation: u32,
        now: u64,
    ) -> Result<Option<DiagnosticTrace>, String> {
        if self.unavailable {
            return Err(STORAGE_ERROR.to_owned());
        }
        if !self.journal.enabled || self.generation != generation {
            return Ok(None);
        }
        self.next_trace_id = self.next_trace_id.wrapping_add(1);
        let trace = DiagnosticTrace {
            generation: self.generation,
            trace_id: self.next_trace_id,
        };
        let mut next = self.journal.clone();
        prune(&mut next, now);
        next.stage = Some(DiagnosticStage::Capture);
        self.persist(next)?;
        self.active_trace = Some(trace);
        Ok(Some(trace))
    }

    fn set_stage(
        &mut self,
        trace: DiagnosticTrace,
        stage: Option<DiagnosticStage>,
        now: u64,
    ) -> Result<(), String> {
        if self.unavailable {
            return Err(STORAGE_ERROR.to_owned());
        }
        if !self.journal.enabled || self.active_trace != Some(trace) {
            return Ok(());
        }
        let mut next = self.journal.clone();
        prune(&mut next, now);
        next.stage = stage;
        self.persist(next)?;
        if stage.is_none() {
            self.active_trace = None;
        }
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), String> {
        if self.unavailable {
            return Err(STORAGE_ERROR.to_owned());
        }
        if self.journal.enabled {
            let mut next = self.journal.clone();
            next.running = false;
            next.running_version = None;
            next.stage = None;
            self.persist(next)?;
        }
        self.active_trace = None;
        Ok(())
    }
}

fn publish_policy(app: &AppHandle, policy: DiagnosticPolicy) {
    if app.emit("diagnostics:policy", policy).is_err() {
        eprintln!("[Verbatim AI] Could not update the diagnostics policy in all windows.");
    }
}

pub fn init(app: &AppHandle) {
    let path = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("diagnostics-v1.json"));
    let manager = match (path, now_ms()) {
        (Ok(path), Ok(now)) => JournalManager::open(path, now),
        (Ok(path), Err(_)) => JournalManager::unavailable(Some(path)),
        (Err(_), _) => JournalManager::unavailable(None),
    };
    app.manage(DiagnosticsState(Mutex::new(manager)));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Some(state) = handle.try_state::<DiagnosticsState>() {
                let result = now_ms().and_then(|now| {
                    let mut manager = state.0.lock().map_err(|_| STORAGE_ERROR.to_owned())?;
                    let result = manager.prune_expired(now);
                    if result.is_err() {
                        publish_policy(&handle, manager.policy());
                    }
                    result
                });
                if result.is_err() {
                    eprintln!("[Verbatim AI] Local diagnostics are unavailable.");
                }
            }
        }
    });
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<DiagnosticsState>() {
        let result = state
            .0
            .lock()
            .map_err(|_| STORAGE_ERROR.to_owned())
            .and_then(|mut manager| manager.shutdown());
        if result.is_err() {
            eprintln!("[Verbatim AI] Could not finish local diagnostics.");
        }
    }
}

#[tauri::command]
pub async fn get_diagnostics(
    app: AppHandle,
    state: State<'_, DiagnosticsState>,
) -> Result<DiagnosticReport, String> {
    let mut manager = state.0.lock().map_err(|_| STORAGE_ERROR.to_owned())?;
    let result = manager.report(now_ms()?);
    if result.is_err() {
        publish_policy(&app, manager.policy());
    }
    result
}

#[tauri::command]
pub async fn get_diagnostics_policy(
    state: State<'_, DiagnosticsState>,
) -> Result<DiagnosticPolicy, String> {
    let manager = state.0.lock().map_err(|_| STORAGE_ERROR.to_owned())?;
    if manager.unavailable {
        return Err(STORAGE_ERROR.to_owned());
    }
    Ok(manager.policy())
}

#[tauri::command]
pub async fn set_diagnostics_enabled(
    app: AppHandle,
    enabled: bool,
    state: State<'_, DiagnosticsState>,
) -> Result<DiagnosticReport, String> {
    let mut manager = state.0.lock().map_err(|_| STORAGE_ERROR.to_owned())?;
    let result = manager.set_enabled(enabled, now_ms()?);
    publish_policy(&app, manager.policy());
    result
}

#[tauri::command]
pub async fn delete_diagnostics(
    app: AppHandle,
    state: State<'_, DiagnosticsState>,
) -> Result<DiagnosticReport, String> {
    let mut manager = state.0.lock().map_err(|_| STORAGE_ERROR.to_owned())?;
    let result = manager
        .disable_and_delete()
        .and_then(|()| manager.report(now_ms()?));
    publish_policy(&app, manager.policy());
    result
}

#[tauri::command]
pub async fn record_diagnostic_event(
    app: AppHandle,
    kind: DiagnosticKind,
    generation: u32,
    state: State<'_, DiagnosticsState>,
) -> Result<(), String> {
    let mut manager = state.0.lock().map_err(|_| STORAGE_ERROR.to_owned())?;
    let result = manager.record(kind, generation, now_ms()?);
    if result.is_err() {
        publish_policy(&app, manager.policy());
    }
    result
}

#[tauri::command]
pub async fn begin_diagnostic_trace(
    app: AppHandle,
    generation: u32,
    state: State<'_, DiagnosticsState>,
) -> Result<Option<DiagnosticTrace>, String> {
    let mut manager = state.0.lock().map_err(|_| STORAGE_ERROR.to_owned())?;
    let result = manager.begin_trace(generation, now_ms()?);
    if result.is_err() {
        publish_policy(&app, manager.policy());
    }
    result
}

#[tauri::command]
pub async fn set_diagnostic_stage(
    app: AppHandle,
    trace: DiagnosticTrace,
    stage: Option<DiagnosticStage>,
    state: State<'_, DiagnosticsState>,
) -> Result<(), String> {
    let mut manager = state.0.lock().map_err(|_| STORAGE_ERROR.to_owned())?;
    let result = manager.set_stage(trace, stage, now_ms()?);
    if result.is_err() {
        publish_policy(&app, manager.policy());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "verbatim-diagnostics-test-{}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn journal(&self) -> PathBuf {
            self.0.join("diagnostics-v1.json")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn disabled_by_default_and_records_nothing() {
        let dir = TestDir::new();
        let path = dir.journal();
        let mut manager = JournalManager::open(path.clone(), 100);
        assert!(!manager.report(100).unwrap().enabled);
        manager
            .record(DiagnosticKind::TranscriptionFailed, manager.generation, 101)
            .unwrap();
        assert!(manager
            .begin_trace(manager.generation, 102)
            .unwrap()
            .is_none());
        assert!(!path.exists());
    }

    #[test]
    fn unclean_exit_preserves_only_the_last_coarse_stage() {
        let dir = TestDir::new();
        let path = dir.journal();
        let mut first = JournalManager::open(path.clone(), 100);
        first.set_enabled(true, 100).unwrap();
        let trace = first.begin_trace(first.generation, 101).unwrap().unwrap();
        first
            .set_stage(trace, Some(DiagnosticStage::Transcription), 102)
            .unwrap();
        let mut restarted = JournalManager::open(path, 200);
        let report = restarted.report(200).unwrap();
        assert_eq!(report.events.len(), 1);
        assert_eq!(report.events[0].kind, DiagnosticKind::UncleanExit);
        assert_eq!(report.events[0].stage, Some(DiagnosticStage::Transcription));
        assert_eq!(report.events[0].app_version, app_version());
    }

    #[test]
    fn normal_shutdown_is_not_reported_as_unclean() {
        let dir = TestDir::new();
        let path = dir.journal();
        let mut first = JournalManager::open(path.clone(), 100);
        first.set_enabled(true, 100).unwrap();
        first.begin_trace(first.generation, 101).unwrap();
        first.shutdown().unwrap();
        let mut restarted = JournalManager::open(path, 200);
        assert!(restarted.report(200).unwrap().events.is_empty());
    }

    #[test]
    fn disabling_deletes_and_rejects_stale_traces() {
        let dir = TestDir::new();
        let path = dir.journal();
        let mut manager = JournalManager::open(path.clone(), 100);
        manager.set_enabled(true, 100).unwrap();
        let old = manager
            .begin_trace(manager.generation, 101)
            .unwrap()
            .unwrap();
        manager
            .record(DiagnosticKind::PolishFailed, manager.generation, 102)
            .unwrap();
        manager.set_enabled(false, 103).unwrap();
        assert!(!path.exists());
        manager.set_enabled(true, 104).unwrap();
        manager
            .record(DiagnosticKind::PolishFailed, old.generation, 105)
            .unwrap();
        assert!(manager.begin_trace(old.generation, 105).unwrap().is_none());
        manager
            .set_stage(old, Some(DiagnosticStage::Polish), 105)
            .unwrap();
        assert_eq!(manager.journal.stage, None);
        assert!(manager.report(105).unwrap().events.is_empty());
    }

    #[test]
    fn newer_trace_cannot_be_changed_by_an_older_trace() {
        let dir = TestDir::new();
        let mut manager = JournalManager::open(dir.journal(), 100);
        manager.set_enabled(true, 100).unwrap();
        let old = manager
            .begin_trace(manager.generation, 101)
            .unwrap()
            .unwrap();
        let new = manager
            .begin_trace(manager.generation, 102)
            .unwrap()
            .unwrap();
        manager
            .set_stage(new, Some(DiagnosticStage::Delivery), 103)
            .unwrap();
        manager.set_stage(old, None, 104).unwrap();
        assert_eq!(manager.journal.stage, Some(DiagnosticStage::Delivery));
    }

    #[test]
    fn bounds_and_expiry_are_applied_to_the_persisted_journal() {
        let dir = TestDir::new();
        let path = dir.journal();
        let mut manager = JournalManager::open(path.clone(), 1_000);
        manager.set_enabled(true, 1_000).unwrap();
        for offset in 0..=MAX_EVENTS {
            manager
                .record(
                    DiagnosticKind::TranscriptionFailed,
                    manager.generation,
                    1_000 + offset as u64,
                )
                .unwrap();
        }
        let report = manager.report(1_100).unwrap();
        assert_eq!(report.events.len(), MAX_EVENTS);
        assert_eq!(report.events[0].recorded_at_ms, 1_001);
        assert!(fs::metadata(&path).unwrap().len() <= MAX_FILE_BYTES);
        assert!(manager
            .report(1_100 + RETENTION_MS + 1)
            .unwrap()
            .events
            .is_empty());
        assert!(read_journal(&path).unwrap().unwrap().events.is_empty());
    }

    #[test]
    fn corrupt_or_oversized_storage_fails_closed_until_deleted() {
        let dir = TestDir::new();
        let path = dir.journal();
        fs::write(&path, vec![b'x'; MAX_FILE_BYTES as usize + 1]).unwrap();
        let mut manager = JournalManager::open(path.clone(), 100);
        assert!(manager.report(100).is_err());
        assert!(manager.set_enabled(true, 100).is_err());
        assert!(path.exists());
        manager.disable_and_delete().unwrap();
        assert!(!path.exists());
        assert!(!manager.report(100).unwrap().enabled);
    }

    #[test]
    fn temporary_files_are_removed_without_restoring_them() {
        let dir = TestDir::new();
        let path = dir.journal();
        fs::write(temp_path(&path), b"uncommitted").unwrap();
        let mut manager = JournalManager::open(path.clone(), 100);
        assert!(!manager.report(100).unwrap().enabled);
        assert!(!temp_path(&path).exists());
    }

    #[test]
    fn storage_failures_are_reported_and_do_not_enable_logging() {
        let dir = TestDir::new();
        let blocker = dir.0.join("not-a-directory");
        fs::write(&blocker, b"synthetic").unwrap();
        let mut manager = JournalManager::open(blocker.join("diagnostics.json"), 100);
        assert!(manager.set_enabled(true, 100).is_err());
        assert!(manager
            .record(DiagnosticKind::PolishFailed, manager.generation, 101)
            .is_err());
        assert!(manager.disable_and_delete().is_err());
    }

    #[test]
    fn failed_replacement_suspends_logging_and_can_be_explicitly_deleted() {
        let dir = TestDir::new();
        let path = dir.journal();
        let mut manager = JournalManager::open(path.clone(), 100);
        manager.set_enabled(true, 100).unwrap();
        manager
            .record(DiagnosticKind::PolishFailed, manager.generation, 101)
            .unwrap();
        fs::write(temp_path(&path), b"synthetic stale temporary file").unwrap();
        assert!(manager
            .record(DiagnosticKind::HistoryWriteFailed, manager.generation, 102)
            .is_err());
        assert!(manager.report(103).is_err());
        let stored = read_journal(&path).unwrap().unwrap();
        assert_eq!(stored.events.len(), 1);
        assert_eq!(stored.events[0].kind, DiagnosticKind::PolishFailed);
        manager.disable_and_delete().unwrap();
        assert!(!path.exists());
        assert!(!temp_path(&path).exists());
        assert!(!manager.report(104).unwrap().enabled);
    }

    #[cfg(unix)]
    #[test]
    fn journal_is_created_with_owner_only_unix_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TestDir::new();
        let path = dir.journal();
        let mut manager = JournalManager::open(path.clone(), 100);
        manager.set_enabled(true, 100).unwrap();
        assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o077, 0);
    }

    #[test]
    fn ipc_and_storage_reject_free_form_content() {
        assert!(serde_json::from_str::<DiagnosticKind>(r#""a synthetic transcript""#).is_err());
        assert!(serde_json::from_str::<DiagnosticStage>(r#""an app window title""#).is_err());
        let invalid = r#"{"schemaVersion":1,"enabled":true,"running":false,"runningVersion":null,"stage":null,"events":[{"recordedAtMs":1,"kind":"polish_failed","appVersion":[0,5,17],"stage":null,"message":"synthetic private text"}]}"#;
        assert!(serde_json::from_str::<Journal>(invalid).is_err());
        let dir = TestDir::new();
        let mut manager = JournalManager::open(dir.journal(), 100);
        assert!(manager
            .record(DiagnosticKind::UncleanExit, manager.generation, 100)
            .is_err());
    }
}
