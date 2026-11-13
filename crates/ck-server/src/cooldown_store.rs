//! Cooldown records and their SQLite persistence.

use std::time::{Duration, SystemTime};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

/// Go `CooldownStateRecord`. An empty `model` is the credential-level record.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Record {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub provider: String,
    #[serde(default)]
    pub auth_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub status: String,
    #[serde(default, with = "go_time")]
    pub next_retry_after: Option<SystemTime>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
    #[serde(default)]
    pub quota: Quota,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<LastError>,
    #[serde(default, with = "go_time")]
    pub updated_at: Option<SystemTime>,
}

/// Go `QuotaState` cooldown fields (`cooldownFieldsOf`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Quota {
    #[serde(default)]
    pub exceeded: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
    #[serde(default, with = "go_time")]
    pub next_recover_at: Option<SystemTime>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub backoff_level: u32,
    #[serde(default, with = "go_time")]
    pub observed_at: Option<SystemTime>,
    /// cook-router only (`max-trusted-cooldown`): bounded windows spent, 0 for none.
    /// Written on every quota record cook-router saves, so its presence marks a record
    /// whose deadline restores as it is. Go's decoder ignores it; records without it
    /// (Go's, or older) get the first bound.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_windows: Option<u32>,
}

/// Go `Error`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LastError {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub http_status: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// Go `time.Time` JSON: RFC 3339 with trimmed nanoseconds; the zero time is
/// `0001-01-01T00:00:00Z` (`None` here).
mod go_time {
    use super::*;

    const ZERO: &str = "0001-01-01T00:00:00Z";

    pub fn serialize<S: serde::Serializer>(t: &Option<SystemTime>, s: S) -> Result<S::Ok, S::Error> {
        match t {
            Some(t) => s.serialize_str(&rfc3339_nano(*t)),
            None => s.serialize_str(ZERO),
        }
    }

    /// Go `time.RFC3339Nano`: nanoseconds with trailing zeros trimmed, no dot when zero.
    pub fn rfc3339_nano(t: SystemTime) -> String {
        let text = DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Nanos, true);
        let (head, _) = text.split_once('Z').unwrap_or((&text, ""));
        let head = head.trim_end_matches('0').trim_end_matches('.');
        format!("{head}Z")
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<SystemTime>, D::Error> {
        let raw = Option::<String>::deserialize(d)?.unwrap_or_default();
        if raw.is_empty() {
            return Ok(None);
        }
        let parsed = DateTime::parse_from_rfc3339(&raw).map_err(serde::de::Error::custom)?;
        // Go's zero time and anything before the epoch mean "no time".
        Ok(u64::try_from(parsed.timestamp())
            .ok()
            .map(|secs| SystemTime::UNIX_EPOCH + Duration::new(secs, parsed.timestamp_subsec_nanos())))
    }
}

/// Durable cooldown snapshots while persistence is on.
pub trait Backend: Send + Sync {
    /// Go `Load`.
    fn load(&self) -> Result<Vec<Record>, String>;
    /// Go `Save`: the complete live set; records no longer present are cleared.
    fn save(&self, records: Vec<Record>, now: SystemTime) -> Result<(), String>;
}

/// One in-flight save and one replaceable snapshot; disk I/O never holds the queue lock.
pub(crate) struct Writer {
    state: std::sync::Arc<(std::sync::Mutex<WriteState>, std::sync::Condvar)>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[derive(Default)]
struct WriteState {
    pending: Option<(Vec<Record>, SystemTime)>,
    writing: bool,
    stopping: bool,
    /// The latest attempt's failure; a later successful checkpoint clears it.
    failed: Option<String>,
}

impl Writer {
    pub(crate) fn new(backend: std::sync::Arc<dyn Backend>) -> Self {
        let state = std::sync::Arc::new((std::sync::Mutex::new(WriteState::default()), std::sync::Condvar::new()));
        let shared = state.clone();
        let thread = std::thread::spawn(move || {
            let (lock, ready) = &*shared;
            loop {
                let mut state = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                while state.pending.is_none() && !state.stopping {
                    state = ready.wait(state).unwrap_or_else(std::sync::PoisonError::into_inner);
                }
                let Some((records, now)) = state.pending.take() else {
                    break;
                };
                state.writing = true;
                drop(state);
                let result = backend.save(records, now);
                if let Err(error) = &result {
                    tracing::warn!(%error, "failed to persist cooldown state");
                }
                let mut state = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                state.failed = result.err();
                state.writing = false;
                ready.notify_all();
            }
        });
        Self {
            state,
            thread: Some(thread),
        }
    }

    pub(crate) fn save(&self, records: Vec<Record>, now: SystemTime) {
        let (lock, ready) = &*self.state;
        lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner).pending = Some((records, now));
        ready.notify_all();
    }

    #[cfg(test)]
    pub(crate) fn flush(&self) {
        let (lock, ready) = &*self.state;
        let mut state = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        while state.pending.is_some() || state.writing {
            state = ready.wait(state).unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}

impl Writer {
    /// Drains the queued snapshot, joins the thread and reports whether the last
    /// checkpoint attempt failed, so a lost final checkpoint is not a clean stop.
    pub(crate) fn stop(mut self) -> Result<(), String> {
        self.join();
        let (lock, _) = &*self.state;
        match lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .failed
            .take()
        {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn join(&mut self) {
        let (lock, ready) = &*self.state;
        lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner).stopping = true;
        ready.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_coalesces_ordered_snapshots_and_drains_on_drop() {
        use std::sync::{Arc, Mutex, mpsc};
        struct Gated {
            entered: mpsc::Sender<()>,
            release: Mutex<mpsc::Receiver<()>>,
            saved: Mutex<Vec<String>>,
        }
        impl Backend for Gated {
            fn load(&self) -> Result<Vec<Record>, String> {
                Ok(Vec::new())
            }
            fn save(&self, records: Vec<Record>, _: SystemTime) -> Result<(), String> {
                if self.saved.lock().unwrap().is_empty() {
                    self.entered.send(()).unwrap();
                    self.release.lock().unwrap().recv().unwrap();
                }
                self.saved.lock().unwrap().push(records[0].model.clone());
                Ok(())
            }
        }
        let (entered, ready) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let backend = Arc::new(Gated {
            entered,
            release: Mutex::new(gate),
            saved: Mutex::new(Vec::new()),
        });
        let writer = Writer::new(backend.clone());
        let snapshot = |model: &str| {
            vec![Record {
                model: model.into(),
                ..Record::default()
            }]
        };
        writer.save(snapshot("first"), SystemTime::now());
        ready.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        writer.save(snapshot("superseded"), SystemTime::now());
        writer.save(snapshot("latest"), SystemTime::now());
        release.send(()).unwrap();
        writer.flush();
        assert_eq!(*backend.saved.lock().unwrap(), ["first", "latest"]);
        writer.save(snapshot("on-drop"), SystemTime::now());
        drop(writer);
        assert_eq!(*backend.saved.lock().unwrap(), ["first", "latest", "on-drop"]);
    }

    #[test]
    fn times_round_trip_go_layout() {
        let t = SystemTime::UNIX_EPOCH + Duration::new(1_790_000_000, 120_000_000);
        let quota = Quota {
            next_recover_at: Some(t),
            ..Default::default()
        };
        let json = serde_json::to_string(&quota).unwrap();
        assert_eq!(
            json,
            r#"{"exceeded":false,"next_recover_at":"2026-09-21T14:13:20.12Z","observed_at":"0001-01-01T00:00:00Z"}"#
        );
        let back: Quota = serde_json::from_str(&json).unwrap();
        assert_eq!(back, quota);
        // Go writes local time with an offset; any offset parses.
        let offset: Quota = serde_json::from_str(r#"{"next_recover_at":"2026-09-21T16:13:20.12+02:00"}"#).unwrap();
        assert_eq!(offset.next_recover_at, Some(t));
        let whole = SystemTime::UNIX_EPOCH + Duration::from_secs(1_790_000_000);
        assert_eq!(go_time::rfc3339_nano(whole), "2026-09-21T14:13:20Z");
    }
}
