use super::*;
use crate::FRAME_BYTES;

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::new(dir.path().join("pool"));
    config.pool_bytes = Some(4 * FRAME_BYTES);
    config.max_event_bytes = 4 * FRAME_BYTES;
    config.header_slots = 8;
    config.workers = 1;
    let store = Store::open(config).unwrap();
    (dir, store)
}

#[test]
fn a_panicking_tick_is_counted_and_the_next_tick_expires_and_decays() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::new(dir.path().join("pool"));
    config.pool_bytes = Some(64 * FRAME_BYTES);
    config.max_event_bytes = FRAME_BYTES;
    config.header_slots = 4;
    config.workers = 1;
    let clock = Arc::new(ManualClock::default());
    let mut store = Store::with_clock(config, clock.clone()).unwrap();
    let mut expiring = store.create().unwrap();
    for _ in 0..30 {
        expiring.append(&[1; FRAME_BYTES]).unwrap();
    }
    // Stop the background thread so every tick below runs synchronously on this thread.
    *store.stop.0.lock().unwrap() = true;
    store.stop.1.notify_all();
    store.worker.take().unwrap().join().unwrap();
    *store.inner.tick_hook.lock() = Some(Box::new(|| panic!("injected maintenance panic")));
    store.inner.maintain();
    assert_eq!(
        store.maintenance_failures(),
        MaintenanceFailures { errors: 0, panics: 1 }
    );
    clock.advance(Duration::from_secs(3601));
    for _ in 0..3 {
        store.inner.maintain();
    }
    assert!(matches!(store.reader(expiring.id(), 0), Err(Error::Gone)));
    assert!(store.inner.pool.cold_frames() > 0, "decay ran after the panic");
    assert_eq!(
        store.maintenance_failures(),
        MaintenanceFailures { errors: 0, panics: 1 }
    );
    let error = store.shutdown().unwrap_err();
    assert_eq!(error.to_string(), "stream maintenance tick panicked");
}

#[derive(Clone, Copy, Debug)]
enum Transition {
    Rollback,
    ReleasePrefix,
    Invalidate,
}

/// Victims are `victim` (2 frames) and `canonical` (1 frame). While eviction sits between
/// counting and invalidating, the victim's writer returns its frames to the pool and, if
/// eviction is still planning, `taker` retakes them as scratch.
fn interleave(transition: Transition) {
    let (_dir, store) = store();
    let planning = Arc::new(AtomicBool::new(false));
    let (planned, planned_signal) = std::sync::mpsc::channel();
    let (moved, moved_signal) = std::sync::mpsc::channel::<()>();
    let hook_planning = planning.clone();
    *store.inner.evict_hook.lock() = Some(Box::new(move || {
        hook_planning.store(true, Ordering::Release);
        planned.send(()).unwrap();
        let _ = moved_signal.recv_timeout(Duration::from_millis(500));
        hook_planning.store(false, Ordering::Release);
    }));
    let mut victim = store.create().unwrap();
    let mut canonical = store.create().unwrap();
    canonical.append(&[2; 10]).unwrap();
    let mut scratch_owner = store.create().unwrap();
    let _scratch = scratch_owner.begin_scratch(FRAME_BYTES).unwrap();
    let mut allocating = store.create().unwrap();
    let mut taker = store.create().unwrap();
    let victim_id = victim.id();
    std::thread::scope(|scope| {
        let (ready, ready_signal) = std::sync::mpsc::channel();
        let writer = scope.spawn(move || {
            let wait = || {
                ready.send(()).unwrap();
                planned_signal.recv().unwrap();
            };
            match transition {
                Transition::Rollback => {
                    let reservation = victim.begin_record(2 * FRAME_BYTES, false, 0, 0).unwrap();
                    wait();
                    drop(reservation);
                }
                Transition::ReleasePrefix => {
                    let end = victim.append(&[1; 2 * FRAME_BYTES]).unwrap().end;
                    wait();
                    victim.release_before(end).unwrap();
                }
                Transition::Invalidate => {
                    victim.append(&[1; 2 * FRAME_BYTES]).unwrap();
                    wait();
                    victim.finish(Terminal::Gone);
                }
            }
            // Holding the scratch keeps any frames it took away from the allocation.
            let taken = planning
                .load(Ordering::Acquire)
                .then(|| taker.begin_scratch(2 * FRAME_BYTES).unwrap());
            let _ = moved.send(());
            taken
        });
        ready_signal.recv().unwrap();
        assert!(
            allocating.append(&[3; 3 * FRAME_BYTES]).is_ok(),
            "{transition:?} moved counted frames during eviction"
        );
        assert!(writer.join().unwrap().is_none(), "{transition:?} ran inside eviction");
    });
    assert!(matches!(store.reader(victim_id, 0), Err(Error::Gone)));
    assert!(matches!(store.reader(canonical.id(), 0), Err(Error::Gone)));
    assert_eq!(store.used_frames(), 4);
}

#[test]
fn victims_cannot_move_frames_between_count_and_invalidation() {
    for transition in [Transition::Rollback, Transition::ReleasePrefix, Transition::Invalidate] {
        interleave(transition);
    }
}

#[test]
fn maintenance_keeps_the_first_error_and_counts_later_ones() {
    let (_dir, store) = store();
    store.inner.record_failure(io::Error::other("first"), false);
    store.inner.record_failure(io::Error::other("second"), false);
    store.inner.record_failure(io::Error::other("third"), true);
    assert_eq!(
        store.maintenance_failures(),
        MaintenanceFailures { errors: 2, panics: 1 }
    );
    assert_eq!(store.take_reclaim_error().unwrap().to_string(), "first");
    assert!(store.take_reclaim_error().is_none());
    store.inner.record_failure(io::Error::other("fourth"), false);
    assert_eq!(store.take_reclaim_error().unwrap().to_string(), "fourth");
}
