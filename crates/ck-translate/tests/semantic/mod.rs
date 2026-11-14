use std::task::Poll;

use ck_stream::{Config, Read, Reader, Store, Writer};
use ck_translate::codec::{Result, source::Source};

/// Real mapped inputs for every protocol's semantic tests. Payload copies belong
/// only in assertions; production codecs receive the same lease-backed Source.
pub struct Mapped {
    pub source: Source,
    pub writer: Writer,
    reader: Reader,
    pub store: Store,
    pub clock: std::sync::Arc<ck_stream::ManualClock>,
    directory: std::path::PathBuf,
}

impl Mapped {
    pub fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("ck-codec-{}", uuid::Uuid::new_v4()));
        let mut config = Config::new(directory.clone());
        config.pool_bytes = Some(64 * ck_stream::FRAME_BYTES);
        config.max_event_bytes = 16 * ck_stream::FRAME_BYTES;
        config.max_metadata_bytes = 4 * 1024 * 1024;
        config.header_slots = 8;
        config.workers = 1;
        let clock = std::sync::Arc::new(ck_stream::ManualClock::default());
        let store = Store::with_clock(config, clock.clone()).unwrap();
        let writer = store.create().unwrap();
        let reader = store.reader(writer.id(), 0).unwrap();
        Self {
            source: Source::new(4 * 1024 * 1024),
            writer,
            reader,
            store,
            clock,
            directory,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let record = self.writer.append(bytes)?;
        let Poll::Ready(Some(Read::Record(lease))) = self.reader.try_next() else {
            panic!("published input unavailable")
        };
        self.source.push(lease, record.start..record.end)?;
        Ok(())
    }

    pub fn output(&self, writer: &Writer) -> Vec<u8> {
        let mut reader = self.store.reader(writer.id(), 0).unwrap();
        let mut bytes = Vec::new();
        while let Poll::Ready(Some(Read::Record(lease))) = reader.try_next() {
            lease.visit(|chunk| bytes.extend_from_slice(chunk)).unwrap();
        }
        bytes
    }
}

impl Drop for Mapped {
    fn drop(&mut self) {
        self.store.shutdown().unwrap();
        std::fs::remove_dir(&self.directory).unwrap();
    }
}
