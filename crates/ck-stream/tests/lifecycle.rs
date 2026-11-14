use ck_stream::{Config, Error, FRAME_BYTES, ManualClock, Read, Store, Terminal};
use std::{
    future::poll_fn,
    sync::{Arc, Barrier, mpsc},
    task::Poll,
    time::Duration,
};

fn store(frames: usize) -> (tempfile::TempDir, Store, Arc<ManualClock>) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::new(dir.path().join("pool"));
    config.pool_bytes = Some(frames * FRAME_BYTES);
    config.max_event_bytes = 4 * FRAME_BYTES;
    config.header_slots = 32;
    config.workers = 2;
    let clock = Arc::new(ManualClock::default());
    let store = Store::with_clock(config, clock.clone()).unwrap();
    (dir, store, clock)
}

fn lease(reader: &mut ck_stream::Reader) -> ck_stream::Lease {
    match reader.try_next() {
        Poll::Ready(Some(Read::Record(lease))) => lease,
        _ => panic!("expected record"),
    }
}

#[tokio::test]
async fn producer_cancellation_wakes_on_eviction_shutdown_expiry_and_explicit_cancel() {
    for (case, expected) in [Terminal::Gone, Terminal::Shutdown, Terminal::Gone, Terminal::Cancelled]
        .into_iter()
        .enumerate()
    {
        let (_dir, mut store, clock) = store(4);
        let mut writer = store.create().unwrap();
        writer.append(&[1; FRAME_BYTES]).unwrap();
        let cancelled = writer.cancelled();
        let (ready, waiting) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            tokio::pin!(cancelled);
            let mut ready = Some(ready);
            poll_fn(|cx| {
                let result = cancelled.as_mut().poll(cx);
                if result.is_pending()
                    && let Some(ready) = ready.take()
                {
                    ready.send(()).unwrap();
                }
                result
            })
            .await
        });
        waiting.await.unwrap();
        match case {
            0 => {
                let mut allocating = store.create().unwrap();
                allocating.append(&[2; 4 * FRAME_BYTES]).unwrap();
            }
            1 => store.shutdown().unwrap(),
            2 => {
                clock.advance(Duration::from_secs(3601));
                store.tick().unwrap();
            }
            3 => writer.finish(Terminal::Cancelled),
            _ => unreachable!(),
        }
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap(),
            expected
        );
        assert_eq!(writer.cancelled().await, expected);
    }
}

#[test]
fn concurrent_readers_keep_distinct_cursors_and_independent_pins() {
    let (_dir, store, _) = store(4);
    let mut writer = store.create().unwrap();
    let mut end = None;
    for byte in 0..3 {
        end = Some(writer.append(&[byte; FRAME_BYTES]).unwrap().end);
    }
    let first = store.reader(writer.id(), 0).unwrap();
    let second = store.reader(writer.id(), 1).unwrap();
    let ready = Barrier::new(3);
    let (release_first, first_release) = mpsc::channel();
    let (release_second, second_release) = mpsc::channel();
    let (dropped, drops) = mpsc::channel();
    std::thread::scope(|scope| {
        for (mut reader, start, release) in [(first, 0, first_release), (second, 1, second_release)] {
            let ready = &ready;
            let dropped = dropped.clone();
            scope.spawn(move || {
                for byte in start..2 {
                    let read = lease(&mut reader);
                    assert_eq!(read.record().sequence, u64::from(byte));
                    assert_eq!(read.chunk(read.record().start).unwrap(), &[byte; FRAME_BYTES]);
                }
                let last = lease(&mut reader);
                assert_eq!(last.record().sequence, 2);
                ready.wait();
                release.recv().unwrap();
                assert_eq!(last.chunk(last.record().start).unwrap(), &[2; FRAME_BYTES]);
                drop(last);
                dropped.send(()).unwrap();
            });
        }
        ready.wait();
        writer.release_before(end.unwrap()).unwrap();
        assert_eq!(store.used_frames(), 1);
        release_first.send(()).unwrap();
        drops.recv().unwrap();
        assert_eq!(store.used_frames(), 1, "the second reader still pins the shared frame");
        release_second.send(()).unwrap();
        drops.recv().unwrap();
    });
    assert_eq!(store.used_frames(), 0);
}

#[test]
fn invalidation_delivers_gone_once_to_every_attached_reader_then_eof() {
    for eviction in [false, true] {
        let (_dir, store, _) = store(4);
        let mut writer = store.create().unwrap();
        writer.append(&[1; FRAME_BYTES]).unwrap();
        writer.append(&[2; FRAME_BYTES]).unwrap();
        let mut readers: Vec<_> = (0..3).map(|after| store.reader(writer.id(), after).unwrap()).collect();
        let pinned = lease(&mut readers[0]);
        let bytes = pinned.chunk(pinned.record().start).unwrap();
        let mut allocating = store.create().unwrap();
        if eviction {
            allocating.append(&[3; 3 * FRAME_BYTES]).unwrap();
        } else {
            writer.finish(Terminal::Gone);
        }
        for reader in &mut readers {
            assert!(matches!(
                reader.try_next(),
                Poll::Ready(Some(Read::Terminal(Terminal::Gone)))
            ));
            assert!(matches!(reader.try_next(), Poll::Ready(None)));
            assert!(matches!(reader.try_next(), Poll::Ready(None)));
        }
        assert_eq!(bytes, &[1; FRAME_BYTES]);
        assert!(matches!(pinned.chunk(pinned.record().start), Err(Error::Gone)));
        assert_eq!(store.used_frames(), if eviction { 4 } else { 1 });
        drop(pinned);
        assert_eq!(store.used_frames(), if eviction { 3 } else { 0 });
    }
}

#[test]
fn invalidation_racing_append_and_reservation_rollback_releases_frames_once() {
    for shutdown in [false, true] {
        let (_dir, mut store, _) = store(8);
        let mut writer = store.create().unwrap();
        writer.append(b"prefix").unwrap();
        let start = Barrier::new(2);
        let (invalidated, invalidation) = mpsc::channel();
        std::thread::scope(|scope| {
            let start = &start;
            scope.spawn(move || {
                start.wait();
                let appended = writer.append(&[2; 128]);
                assert!(appended.is_ok() || matches!(appended, Err(Error::Gone | Error::Closed)));
                invalidation.recv().unwrap();
                assert!(matches!(
                    writer.append(b"after invalidation"),
                    Err(Error::Gone | Error::Closed)
                ));
            });
            start.wait();
            if shutdown {
                store.shutdown().unwrap();
            } else {
                let mut allocating = store.create().unwrap();
                allocating.append(&[3; 4 * FRAME_BYTES]).unwrap();
                // Filling the pool forces eviction even if append completed first.
                allocating.append(&[3; 4 * FRAME_BYTES]).unwrap();
                allocating.finish(Terminal::Gone);
            }
            invalidated.send(()).unwrap();
        });
        assert_eq!(store.used_frames(), 0);

        let (_dir, mut store, _) = self::store(4);
        let mut writer = store.create().unwrap();
        writer.append(&[1; FRAME_BYTES]).unwrap();
        let reserved = Barrier::new(2);
        let (invalidated, invalidation) = mpsc::channel();
        std::thread::scope(|scope| {
            let reserved = &reserved;
            scope.spawn(move || {
                let mut reservation = writer.begin_record(FRAME_BYTES, false, 0, 0).unwrap();
                reservation.write(&[2; FRAME_BYTES]).unwrap();
                reserved.wait();
                invalidation.recv().unwrap();
                assert!(matches!(reservation.commit(), Err(Error::Gone | Error::Closed)));
            });
            reserved.wait();
            if shutdown {
                store.shutdown().unwrap();
            } else {
                let mut allocating = store.create().unwrap();
                allocating.append(&[3; 3 * FRAME_BYTES]).unwrap();
                allocating.finish(Terminal::Gone);
            }
            invalidated.send(()).unwrap();
        });
        assert_eq!(
            store.used_frames(),
            0,
            "rollback must not release an invalidated frame twice"
        );
    }
}

#[test]
fn attach_and_each_pending_wait_refresh_eviction_recency() {
    for waiting in [false, true] {
        let (_dir, store, clock) = store(4);
        let mut first = store.create().unwrap();
        first.append(&[1; FRAME_BYTES]).unwrap();
        let mut second = store.create().unwrap();
        second.append(&[2; FRAME_BYTES]).unwrap();
        clock.advance(Duration::from_secs(1));
        let mut reader = store.reader(first.id(), 1).unwrap();
        if waiting {
            clock.advance(Duration::from_secs(1));
            drop(store.reader(second.id(), 1).unwrap());
            clock.advance(Duration::from_secs(1));
            assert!(matches!(reader.try_next(), Poll::Pending));
        }
        let mut allocating = store.create().unwrap();
        allocating.append(&[3; 3 * FRAME_BYTES]).unwrap();
        assert!(matches!(store.reader(second.id(), 0), Err(Error::Gone)));
        assert!(matches!(reader.try_next(), Poll::Pending));
    }
}

#[test]
fn terminals_render_only_registered_codes_and_reasons() {
    use Terminal::*;
    let rendered: Vec<_> = [
        Done,
        Cancelled,
        Shutdown,
        UpstreamError,
        StorageExhausted,
        Gone,
        ProducerLost,
    ]
    .into_iter()
    .map(|terminal| (terminal.error_code(), terminal.cancel_reason()))
    .collect();
    assert_eq!(
        rendered,
        [
            (None, None),
            (None, Some("client_cancel")),
            (None, Some("shutdown")),
            (None, None),
            (Some("stream.storage_exhausted"), None),
            (Some("stream.gone"), None),
            (Some("stream.producer_lost"), None),
        ]
    );
}

#[test]
fn dropped_writer_ends_readers_with_producer_lost_not_client_cancel() {
    let (_dir, store, _) = store(4);
    let mut lost = store.create().unwrap();
    lost.append(b"prefix").unwrap();
    let mut reader = store.reader(lost.id(), 0).unwrap();
    let id = lost.id();
    drop(lost);
    for mut reader in [reader, store.reader(id, 0).unwrap()] {
        assert_eq!(lease(&mut reader).record().sequence, 0);
        assert!(matches!(
            reader.try_next(),
            Poll::Ready(Some(Read::Terminal(Terminal::ProducerLost)))
        ));
    }
    assert_eq!(Terminal::ProducerLost.error_code(), Some("stream.producer_lost"));
    assert_eq!(Terminal::ProducerLost.cancel_reason(), None);
    // An explicit client cancel stays a cancellation after the writer drops.
    let mut cancelled = store.create().unwrap();
    cancelled.finish(Terminal::Cancelled);
    reader = store.reader(cancelled.id(), 0).unwrap();
    drop(cancelled);
    assert!(matches!(
        reader.try_next(),
        Poll::Ready(Some(Read::Terminal(Terminal::Cancelled)))
    ));
}
