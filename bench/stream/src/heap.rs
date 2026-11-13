use anyhow::{Result, bail};
use ck_stream::{FRAME_BYTES, Position, Record, Terminal};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    task::Poll,
};
use tokio::sync::Notify;

#[derive(Default)]
#[repr(align(128))]
pub struct Store {
    streams: Mutex<HashMap<u64, Arc<Stream>>>,
    next: AtomicU64,
}

#[derive(Default)]
struct State {
    frames: Vec<Box<[u8]>>,
    records: Vec<(u64, u64, u32, u32)>,
    end: usize,
    terminal: Option<Terminal>,
}

#[repr(align(128))]
struct Stream {
    state: Mutex<State>,
    committed: AtomicU64,
    notify: Notify,
}

pub struct Writer {
    stream: Arc<Stream>,
    id: u64,
}
pub struct Reader {
    stream: Arc<Stream>,
    id: u64,
    next: usize,
    done: bool,
}
pub struct Lease {
    stream: Arc<Stream>,
    record: Record,
}

fn position(id: u64, byte: usize) -> Position {
    Position {
        generation: id,
        frame: (byte / FRAME_BYTES) as u64,
        offset: (byte % FRAME_BYTES) as u32,
    }
}

impl Store {
    pub fn create(&self) -> Writer {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let stream = Arc::new(Stream {
            state: Mutex::new(State::default()),
            committed: AtomicU64::new(0),
            notify: Notify::new(),
        });
        self.streams.lock().unwrap().insert(id, stream.clone());
        Writer { stream, id }
    }
    pub fn reader(&self, id: u64) -> Result<Reader> {
        let stream = self
            .streams
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("heap stream.gone"))?;
        Ok(Reader {
            stream,
            id,
            next: 0,
            done: false,
        })
    }
    pub fn expire(&self) {
        self.streams.lock().unwrap().clear();
    }
}

impl Writer {
    pub fn id(&self) -> u64 {
        self.id
    }
    pub fn append(&mut self, bytes: &[u8], aligned: bool) -> Result<()> {
        let mut state = self.stream.state.lock().unwrap();
        if state.terminal.is_some() {
            bail!("heap stream terminal");
        }
        if bytes.is_empty() || bytes.len() > 1024 * 1024 || (aligned && bytes.len() > FRAME_BYTES) {
            bail!("heap event limit");
        }
        let start = if aligned {
            state.end.div_ceil(FRAME_BYTES) * FRAME_BYTES
        } else {
            state.end
        };
        let end = start + bytes.len();
        if end.div_ceil(FRAME_BYTES) > 5368 {
            bail!("heap stream.storage_exhausted");
        }
        while state.frames.len() < end.div_ceil(FRAME_BYTES) {
            state.frames.push(vec![0u8; FRAME_BYTES].into_boxed_slice());
        }
        let mut offset = 0;
        while offset < bytes.len() {
            let byte = start + offset;
            let n = (FRAME_BYTES - byte % FRAME_BYTES).min(bytes.len() - offset);
            state.frames[byte / FRAME_BYTES][byte % FRAME_BYTES..byte % FRAME_BYTES + n]
                .copy_from_slice(&bytes[offset..offset + n]);
            offset += n;
        }
        state.records.push((start as u64, end as u64, 0, 0));
        state.end = end;
        self.stream.committed.store(end as u64, Ordering::Release);
        drop(state);
        self.stream.notify.notify_waiters();
        Ok(())
    }
    pub fn finish(&mut self) {
        self.stream.state.lock().unwrap().terminal = Some(Terminal::Done);
        self.stream.notify.notify_waiters();
    }
}

impl Reader {
    pub fn try_next(&mut self) -> Poll<Option<Lease>> {
        if self.done {
            return Poll::Ready(None);
        }
        let state = self.stream.state.lock().unwrap();
        let committed = self.stream.committed.load(Ordering::Acquire);
        if let Some((start, end, kind, correlation)) = state.records.get(self.next).copied()
            && end <= committed
        {
            let record = Record {
                sequence: self.next as u64,
                start: position(self.id, start as usize),
                end: position(self.id, end as usize),
                kind,
                correlation,
            };
            self.next += 1;
            return Poll::Ready(Some(Lease {
                stream: self.stream.clone(),
                record,
            }));
        }
        if state.terminal.is_some() {
            self.done = true;
            Poll::Ready(None)
        } else {
            Poll::Pending
        }
    }
    pub async fn next(&mut self) -> Option<Lease> {
        loop {
            let stream = self.stream.clone();
            let notified = stream.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Poll::Ready(value) = self.try_next() {
                return value;
            }
            notified.await;
        }
    }
}

impl Lease {
    pub fn visit(&self, mut visitor: impl FnMut(&[u8])) {
        let state = self.stream.state.lock().unwrap();
        let mut byte = self.record.start.frame as usize * FRAME_BYTES + self.record.start.offset as usize;
        let end = self.record.end.frame as usize * FRAME_BYTES + self.record.end.offset as usize;
        while byte < end {
            let n = (FRAME_BYTES - byte % FRAME_BYTES).min(end - byte);
            visitor(&state.frames[byte / FRAME_BYTES][byte % FRAME_BYTES..byte % FRAME_BYTES + n]);
            byte += n;
        }
    }
}
