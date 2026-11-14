use ck_stream::{Config, Error, FRAME_BYTES, ManualClock, Store, Terminal};
use std::{sync::Arc, task::Poll, time::Duration};

fn store(frames: usize, slots: u32) -> (tempfile::TempDir, Store, Arc<ManualClock>) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::new(dir.path().join("pool"));
    config.pool_bytes = Some(frames * FRAME_BYTES);
    config.max_frames = Some(4);
    config.max_event_bytes = 4 * FRAME_BYTES;
    config.header_slots = slots;
    config.workers = 1;
    let clock = Arc::new(ManualClock::default());
    let store = Store::with_clock(config, clock.clone()).unwrap();
    (dir, store, clock)
}

#[test]
fn oldest_read_age_counts_attached_readers_as_fresh_and_skips_invalidated_streams() {
    let (_dir, store, clock) = store(8, 32);
    assert_eq!(store.stats().oldest_read_age, None);
    let mut attached = store.create().unwrap();
    attached.append(b"read").unwrap();
    let reader = store.reader(attached.id(), 0).unwrap();
    clock.advance(Duration::from_secs(5));
    let mut unread = store.create().unwrap();
    clock.advance(Duration::from_secs(5));
    // `attached` was last read at 0 but has a reader; `unread` counts from its creation at 5.
    let stats = store.stats();
    assert_eq!(stats.oldest_read_age, Some(Duration::from_secs(5)));
    assert_eq!(stats.cached_streams, 2);
    drop(reader);
    clock.advance(Duration::from_secs(1));
    unread.finish(Terminal::Gone);
    assert_eq!(store.stats().oldest_read_age, Some(Duration::from_secs(1)));
}

#[test]
fn expiry_is_counted_once_per_stream_and_is_not_an_eviction() {
    let (_dir, store, clock) = store(8, 32);
    let mut expiring = store.create().unwrap();
    expiring.append(b"old").unwrap();
    clock.advance(Duration::from_secs(3601));
    let fresh = store.create().unwrap();
    store.tick().unwrap();
    store.tick().unwrap();
    let stats = store.stats();
    assert_eq!((stats.expiries, stats.evictions, stats.cached_streams), (1, 0, 1));
    assert!(store.reader(fresh.id(), 0).is_ok());
    assert!(matches!(store.reader(expiring.id(), 0), Err(Error::Gone)));
}

#[test]
fn frame_and_slot_pressure_count_every_victim() {
    let (_dir, store, clock) = store(4, 4);
    let mut writers = Vec::new();
    for _ in 0..4 {
        let mut writer = store.create().unwrap();
        writer.append(&[1; FRAME_BYTES]).unwrap();
        writers.push(writer);
        clock.advance(Duration::from_secs(1));
    }
    // Two frames free only by invalidating the two least recently read streams.
    let mut allocating = writers.remove(3);
    allocating.append(&[2; 2 * FRAME_BYTES]).unwrap();
    assert_eq!(store.stats().evictions, 2);
    // Two slots are held; two new streams fit, the third evicts one more.
    let _second = store.create().unwrap();
    let _third = store.create().unwrap();
    assert_eq!(store.stats().evictions, 2);
    let _fourth = store.create().unwrap();
    let stats = store.stats();
    assert_eq!((stats.evictions, stats.allocation_failures, stats.expiries), (3, 0, 0));
}

#[test]
fn per_stream_limit_counts_one_failure_with_its_charge_and_evicts_nothing() {
    let (_dir, store, _) = store(8, 32);
    let mut other = store.create().unwrap();
    other.append(b"other").unwrap();
    let mut writer = store.create().unwrap();
    writer.append(&vec![1; 4 * FRAME_BYTES]).unwrap();
    assert_eq!(writer.storage_failure_frames(), None);
    assert!(matches!(writer.append(b"over"), Err(Error::StorageExhausted)));
    assert!(matches!(writer.append(b"after"), Err(Error::Closed)));
    assert_eq!(writer.storage_failure_frames(), Some(4));
    assert_eq!(other.storage_failure_frames(), None);
    let stats = store.stats();
    assert_eq!(stats.allocation_failures, 1);
    assert_eq!(stats.last_storage_exhausted_frames, Some(4));
    assert_eq!(stats.evictions, 0);
    assert_eq!(stats.cache_bytes, u64::from(stats.used_frames) * FRAME_BYTES as u64);
    assert_eq!(stats.used_frames, 5);
}

#[test]
fn failure_charge_includes_scratch_frames() {
    let (_dir, store, _) = store(8, 32);
    let mut writer = store.create().unwrap();
    let mut scratch = writer.begin_scratch(FRAME_BYTES).unwrap();
    scratch.write(&[3; FRAME_BYTES]).unwrap();
    let _scratch = scratch.complete().unwrap();
    writer.append(&[1; FRAME_BYTES]).unwrap();
    // Two more frames would exceed the limit of four; the reservation takes none of them.
    assert!(matches!(
        writer.append(&vec![2; 2 * FRAME_BYTES + 1]),
        Err(Error::StorageExhausted)
    ));
    assert_eq!(writer.storage_failure_frames(), Some(2));
    assert_eq!(store.stats().last_storage_exhausted_frames, Some(2));
}

#[test]
fn failure_charge_excludes_frames_a_failed_reservation_rolled_back() {
    let (_dir, store, _) = store(4, 32);
    let mut pinned = store.create().unwrap();
    pinned.append(&[1; FRAME_BYTES]).unwrap();
    let mut reader = store.reader(pinned.id(), 0).unwrap();
    let Poll::Ready(Some(ck_stream::Read::Record(_lease))) = reader.try_next() else {
        panic!("expected record");
    };
    let mut writer = store.create().unwrap();
    writer.append(&[2; FRAME_BYTES]).unwrap();
    // Two of the three frames are free; the leased stream cannot give the third.
    assert!(matches!(
        writer.append(&vec![3; 2 * FRAME_BYTES + 1]),
        Err(Error::StorageExhausted)
    ));
    assert_eq!(writer.storage_failure_frames(), Some(1));
    let stats = store.stats();
    assert_eq!(
        (stats.allocation_failures, stats.evictions, stats.used_frames),
        (1, 0, 2)
    );
}
