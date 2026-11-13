//! Behavioral tests at the public command/subscription ports, with real private
//! SQLite artifacts and filesystem-effect faults. No State-layout assertions.
use super::*;
use crate::cooldown_store::Backend;
use crate::credential_store::CredentialDb;
use crate::testing::installation_effects::{self, Stage};
use std::sync::mpsc;
use std::time::Duration;

fn receive<T>(receiver: &mpsc::Receiver<T>) -> T {
    receiver.recv_timeout(Duration::from_secs(10)).unwrap()
}

fn executors() -> cpa_exec::Executors {
    cpa_exec::Executors {
        claude: cpa_exec::claude::ClaudeExecutor::new("http://127.0.0.1:9").unwrap(),
        codex: Default::default(),
        devices: Default::default(),
        openai: Default::default(),
        google: Default::default(),
    }
}

struct Fixture {
    dir: PathBuf,
    store: Arc<ConfigStore>,
    db: Arc<CredentialDb>,
    rt: Arc<crate::Runtime>,
    management: Arc<crate::management::Management>,
}

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("cpa-ordered-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let store = Arc::new(crate::testing::config_store(&dir.join("config.db")).unwrap());
        store
            .import_yaml("routing: {strategy: round-robin}\n", "test", "")
            .unwrap();
        let db = CredentialDb::initialize(store.clone()).unwrap();
        let rt = Arc::new(crate::testing::runtime_with_db(
            store.load().unwrap().config,
            vec![],
            executors(),
            db.clone(),
        ));
        let management = crate::management::Management::new(rt.clone(), store.clone());
        Self {
            dir,
            store,
            db,
            rt,
            management,
        }
    }

    fn checkpoint(&self) -> PathBuf {
        PathBuf::from(crate::testing::database_connection(&self.store).path().unwrap())
    }

    fn finish(self) {
        let Self {
            dir,
            store,
            db,
            rt,
            management,
        } = self;
        drop((management, rt, db, store));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn service_commit_updates_bound_runtime_before_returning() {
    let f = Fixture::new();
    let mut changes = f.rt.subscribe_config();
    let rt = Arc::downgrade(&f.rt);
    let store = Arc::downgrade(&f.store);
    let (tx, rx) = mpsc::channel();
    let subscription = f
        .store
        .subscribe_configuration(move |view| {
            let rt = rt.upgrade().unwrap();
            let current = store.upgrade().unwrap().load().unwrap();
            assert_eq!(current.rev, view.revision);
            assert_eq!(current.digest, view.digest);
            assert_eq!(rt.config().routing.strategy, view.config.routing.strategy);
            let (config, policy) = rt.request_snapshot();
            assert_eq!(crate::management::policy(&config).strategy, policy.strategy);
            tx.send((view.revision, view.config.routing.strategy.clone())).unwrap();
            Ok(())
        })
        .unwrap();
    let initial = receive(&rx);
    // Internal service command: no Management adapter publication afterward.
    let committed = f
        .store
        .import_yaml("routing: {strategy: fill-first}\n", "test", "")
        .unwrap();
    assert_eq!(receive(&rx), (committed.rev, "fill-first".into()));
    assert!(committed.rev > initial.0);
    assert_eq!(f.management.published_rev(), committed.rev);
    let delivered = changes.try_next().expect("the commit reaches runtime consumers");
    assert_eq!(delivered.config.routing.strategy, "fill-first");
    assert!(changes.try_next().is_none(), "one commit is one runtime delivery");
    drop(subscription);
    f.finish();
}

#[test]
fn runtime_consumers_receive_each_owner_commit_in_order_with_its_view() {
    let f = Fixture::new();
    let mut changes = f.rt.subscribe_config();
    let start = changes.current().sequence;
    // Two commits land before the consumer looks: neither is folded into the other.
    let first = f
        .store
        .import_yaml("routing: {strategy: fill-first}\n", "test", "")
        .unwrap();
    let second = f
        .store
        .import_yaml("routing: {strategy: round-robin}\n", "test", "")
        .unwrap();
    assert!(second.rev > first.rev);
    let a = changes.try_next().expect("the first commit");
    let b = changes.try_next().expect("the second commit");
    assert_eq!(
        (a.sequence, a.config.routing.strategy.as_str()),
        (start + 1, "fill-first")
    );
    assert_eq!(
        (b.sequence, b.config.routing.strategy.as_str()),
        (start + 2, "round-robin")
    );
    assert!(changes.try_next().is_none());
    // A consumer computing from the view it holds is unaffected by a later commit.
    let held = a.clone();
    f.store
        .import_yaml("routing: {strategy: fill-first}\n", "test", "")
        .unwrap();
    assert_eq!(held.config.routing.strategy, "fill-first");
    assert_eq!(b.config.routing.strategy, "round-robin");
    assert_eq!(changes.try_next().unwrap().config.routing.strategy, "fill-first");
    // Credential commits are another domain: no runtime configuration delivery.
    f.db.save(&f.db.auth_dir().join("ordered.json"), b"{}").unwrap();
    assert!(changes.try_next().is_none());
    f.finish();
}

#[test]
fn rejected_dry_run_and_other_domain_commands_do_not_notify_configuration() {
    let f = Fixture::new();
    let (tx, rx) = mpsc::channel();
    let subscription = f
        .store
        .subscribe_configuration(move |view| {
            tx.send(view.revision).unwrap();
            Ok(())
        })
        .unwrap();
    let revision = receive(&rx);
    let before = std::fs::read(f.store.path().unwrap()).unwrap();
    assert!(f.store.import_yaml("[", "test", "").is_err());
    let op = put("setting", "routing", json!({"strategy": "fill-first"}));
    // A well-formed command whose candidate fails validation is rejected as a whole.
    let invalid = f
        .store
        .commit(&[op.clone(), put("setting", "routing2", json!({}))], "test", "", false)
        .unwrap_err();
    assert_eq!(invalid.status, 422);
    assert!(
        f.store
            .commit_if(
                std::slice::from_ref(&op),
                "test",
                "",
                false,
                Some(Precondition::Revision(0))
            )
            .is_err()
    );
    assert!(!f.store.commit_if(&[op], "test", "", true, None).unwrap().written);
    assert_eq!(std::fs::read(f.store.path().unwrap()).unwrap(), before);
    let path = f.db.auth_dir().join("grant.json");
    f.db.save(&path, b"{\n \"refresh_token\":\"R1\"\n}\n").unwrap();
    let after_grant = std::fs::read(f.store.path().unwrap()).unwrap();
    let cooling = crate::cooldown_store::Record {
        auth_id: "grant.json".into(),
        provider: "codex".into(),
        model: "m".into(),
        status: "cooling".into(),
        ..Default::default()
    };
    Backend::save(&*f.db, vec![cooling], std::time::SystemTime::now()).unwrap();
    let persisted = Backend::load(&*f.db).unwrap();
    assert_eq!((persisted.len(), persisted[0].model.as_str()), (1, "m"));
    assert_ne!(
        std::fs::read(f.store.path().unwrap()).unwrap(),
        after_grant,
        "the cooldown checkpoint is a real durable owner command"
    );
    assert_eq!(f.db.read(&path).unwrap().unwrap(), b"{\n \"refresh_token\":\"R1\"\n}\n");
    assert_eq!(f.store.load().unwrap().rev, revision);
    assert_eq!(f.management.published_rev(), revision);
    assert!(rx.try_recv().is_err());
    drop(subscription);
    f.finish();
}

#[test]
fn storage_faults_do_not_publish_and_retained_configuration_retries_once() {
    for (checkpoint, stage) in [
        (true, Stage::BeforeReplace),
        (true, Stage::AfterReplace),
        (false, Stage::BeforeReplace),
        (false, Stage::AfterReplace),
    ] {
        let f = Fixture::new();
        let (tx, rx) = mpsc::channel();
        let subscription = f
            .store
            .subscribe_configuration(move |view| {
                tx.send((view.revision, view.config.routing.strategy.clone())).unwrap();
                Ok(())
            })
            .unwrap();
        let initial = receive(&rx);
        let mut watch = f.rt.subscribe_config();
        let destination = if checkpoint {
            f.checkpoint()
        } else {
            f.store.path().unwrap().to_owned()
        };
        let fault = installation_effects::once(&destination, stage, || {
            Err(std::io::Error::other("fixture storage fault"))
        });
        assert!(
            f.store
                .import_yaml("routing: {strategy: fill-first}\n", "test", "")
                .is_err()
        );
        assert_eq!(f.store.load().unwrap().rev, initial.0);
        assert_eq!(f.rt.config().routing.strategy, "round-robin");
        assert_eq!(f.management.published_rev(), initial.0);
        assert!(watch.try_next().is_none());
        assert!(rx.try_recv().is_err());
        drop(fault);
        let retry = f
            .store
            .import_yaml("routing: {strategy: fill-first}\n", "test", "")
            .unwrap();
        assert_eq!(retry.written, checkpoint && stage == Stage::BeforeReplace);
        assert_eq!(receive(&rx), (retry.rev, "fill-first".into()));
        assert!(
            rx.try_recv().is_err(),
            "pending reconciliation must dispatch once, even for a no-op retry"
        );
        assert_eq!(f.rt.config().routing.strategy, "fill-first");
        assert_eq!(f.management.published_rev(), retry.rev);
        let copy = f.dir.join("only-copy.db");
        std::fs::copy(f.store.path().unwrap(), &copy).unwrap();
        let recovered = crate::testing::config_store(&copy).unwrap();
        assert_eq!(recovered.load().unwrap().rev, retry.rev);
        assert_eq!(recovered.load().unwrap().config.routing.strategy, "fill-first");
        drop((recovered, subscription));
        f.finish();
    }
}

#[test]
fn readers_keep_complete_old_views_while_storage_is_blocked() {
    let f = Fixture::new();
    let held = f.rt.config();
    let before = f.store.snapshot().unwrap();
    let (entered, wait) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    let barrier = installation_effects::once(&f.checkpoint(), Stage::BeforeReplace, move || {
        entered.send(()).unwrap();
        resume.recv_timeout(Duration::from_secs(10)).unwrap();
        Ok(())
    });
    let store = f.store.clone();
    let writer = std::thread::spawn(move || store.import_yaml("routing: {strategy: fill-first}\n", "test", ""));
    wait.recv_timeout(Duration::from_secs(10)).unwrap();
    let store = f.store.clone();
    let rt = f.rt.clone();
    let (read, completed) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        read.send((store.snapshot().unwrap(), rt.config().routing.strategy.clone()))
            .unwrap()
    });
    let observed = completed.recv_timeout(Duration::from_secs(2));
    // Always release/join storage, including on an oracle failure.
    release.send(()).unwrap();
    let committed = writer.join().unwrap().unwrap();
    reader.join().unwrap();
    assert_eq!(observed.unwrap(), (before, "round-robin".into()));
    assert_eq!(held.routing.strategy, "round-robin");
    assert_eq!(f.rt.config().routing.strategy, committed.config.routing.strategy);
    drop(barrier);
    f.finish();
}

#[test]
fn callback_errors_reads_unsubscription_and_owned_followup_do_not_deadlock() {
    let store = Arc::new(ConfigStore::memory_with("server: {port: 8101}\n"));
    let weak = Arc::downgrade(&store);
    let (followup, jobs) = mpsc::channel();
    let worker_store = store.clone();
    let worker = std::thread::spawn(move || {
        jobs.recv_timeout(Duration::from_secs(10)).unwrap();
        worker_store
            .import_yaml("server: {port: 8103}\n", "test", "followup")
            .unwrap();
    });
    let failing = store
        .subscribe_configuration(|_| anyhow::bail!("fixture subscriber error"))
        .unwrap();
    let own_handle = Arc::new(Mutex::new(None::<ConfigurationSubscription>));
    let release_handle = own_handle.clone();
    let (tx, rx) = mpsc::channel();
    let subscription = store
        .subscribe_configuration(move |view| {
            let store = weak.upgrade().unwrap();
            assert_eq!(store.load().unwrap().rev, view.revision);
            if view.config.port == 8102 {
                assert!(store.import_yaml("server: {port: 8199}\n", "test", "reentry").is_err());
                release_handle.lock().unwrap().take();
                followup.send(()).unwrap();
            }
            tx.send(view.config.port).unwrap();
            Ok(())
        })
        .unwrap();
    *own_handle.lock().unwrap() = Some(subscription);
    assert_eq!(receive(&rx), 8101);
    let (all, delivered) = mpsc::channel();
    let observer = store
        .subscribe_configuration(move |view| {
            all.send((view.revision, view.config.port)).unwrap();
            Ok(())
        })
        .unwrap();
    let initial = receive(&delivered);
    let done = store.import_yaml("server: {port: 8102}\n", "test", "").unwrap();
    worker.join().unwrap();
    assert_eq!(receive(&rx), 8102);
    assert!(rx.try_recv().is_err(), "self-unsubscription excludes the later command");
    assert_eq!(receive(&delivered), (done.rev, 8102));
    assert_eq!(receive(&delivered), (done.rev + 1, 8103));
    assert!(done.rev > initial.0);
    assert_eq!(store.load().unwrap().config.port, 8103);
    drop((failing, observer));
}

#[test]
fn registering_concurrently_with_publication_has_no_version_gap() {
    for _ in 0..16 {
        let store = Arc::new(ConfigStore::memory_with("server: {port: 8111}\n"));
        let start = Arc::new(std::sync::Barrier::new(3));
        let publishing = store.clone();
        let publish_start = start.clone();
        let publisher = std::thread::spawn(move || {
            publish_start.wait();
            publishing.import_yaml("server: {port: 8112}\n", "test", "").unwrap()
        });
        let subscribing = store.clone();
        let subscribe_start = start.clone();
        let (tx, rx) = mpsc::channel();
        let subscriber = std::thread::spawn(move || {
            subscribe_start.wait();
            subscribing
                .subscribe_configuration(move |view| {
                    tx.send((view.revision, view.config.port)).unwrap();
                    Ok(())
                })
                .unwrap()
        });
        start.wait();
        let committed = publisher.join().unwrap();
        let subscription = subscriber.join().unwrap();
        let events: Vec<_> = rx.try_iter().collect();
        assert!(
            events == vec![(committed.rev, 8112)] || events == vec![(committed.rev - 1, 8111), (committed.rev, 8112)]
        );
        drop(subscription);
        store.import_yaml("server: {port: 8113}\n", "test", "").unwrap();
        assert!(rx.try_recv().is_err());
    }
}

#[test]
fn binding_refuses_volatile_ports_without_effects_but_preserves_standalone_ports() {
    let f = Fixture::new();
    let snapshot = f.rt.config();
    let policy = f.rt.policy();
    let generation = f.rt.store().snapshot();
    let mut changes = f.rt.subscribe_config();
    let next = Config::parse("routing: {strategy: fill-first}\n").unwrap();
    assert!(!f.rt.publish_config(next.clone()));
    assert!(
        !f.rt
            .publish_config_and_policy(next.clone(), crate::management::policy(&next))
    );
    assert!(Arc::ptr_eq(&snapshot, &f.rt.config()));
    assert!(Arc::ptr_eq(&policy, &f.rt.policy()));
    assert_eq!(
        generation.iter().map(|c| &c.id).collect::<Vec<_>>(),
        f.rt.store().snapshot().iter().map(|c| &c.id).collect::<Vec<_>>()
    );
    assert!(changes.try_next().is_none());
    let standalone = crate::testing::runtime(
        Config::parse("routing: {strategy: round-robin}\n").unwrap(),
        vec![],
        executors(),
    );
    assert!(standalone.publish_config(next));
    assert_eq!(standalone.config().routing.strategy, "fill-first");
    drop(standalone);
    f.finish();
}

#[test]
fn initial_binding_wins_over_a_racing_volatile_publication() {
    for _ in 0..12 {
        let store = Arc::new(ConfigStore::memory_with("routing: {strategy: fill-first}\n"));
        let rt = Arc::new(crate::testing::runtime(
            Config::parse("routing: {strategy: round-robin}\n").unwrap(),
            vec![],
            executors(),
        ));
        let mut before = rt.subscribe_config();
        assert_eq!(before.current().config.routing.strategy, "round-robin");
        let race = rt.clone();
        let start = Arc::new(std::sync::Barrier::new(2));
        let publishing = start.clone();
        let publisher = std::thread::spawn(move || {
            publishing.wait();
            race.publish_config(Config::parse("routing: {strategy: wrr}\n").unwrap())
        });
        start.wait();
        let management = crate::management::Management::new(rt.clone(), store.clone());
        publisher.join().unwrap();
        assert_eq!(rt.config().routing.strategy, "fill-first");
        // Subscribers follow the bound view, whether the racing publication landed
        // before binding or was refused after it.
        let mut last = None;
        while let Some(change) = before.try_next() {
            last = Some(change.config.routing.strategy.clone());
        }
        assert_eq!(last.as_deref(), Some("fill-first"));
        assert_eq!(rt.subscribe_config().current().config.routing.strategy, "fill-first");
        assert_eq!(
            rt.policy().strategy,
            crate::management::policy(&store.load().unwrap().config).strategy
        );
        assert!(!rt.publish_config(Config::default()));
        drop(management);
    }
}

#[test]
fn resume_publishes_an_unacknowledged_checkpoint_before_initial_delivery() {
    let f = Fixture::new();
    let (tx, rx) = mpsc::channel();
    let subscription = f
        .store
        .subscribe_configuration(move |view| {
            tx.send(view.revision).unwrap();
            Ok(())
        })
        .unwrap();
    let old_revision = receive(&rx);
    let blocked = crate::testing::block_publication(f.store.path().unwrap());
    assert!(
        f.store
            .import_yaml("routing: {strategy: fill-first}\n", "test", "unacknowledged")
            .is_err()
    );
    assert!(rx.try_recv().is_err());
    drop(blocked);
    let path = f.store.path().unwrap().to_path_buf();
    let checkpoint = f.checkpoint();
    let Fixture {
        dir,
        store,
        db,
        rt,
        management,
    } = f;
    drop(subscription);
    drop((management, rt, db, store));
    assert!(
        checkpoint.exists(),
        "unresolved checkpoint survives the old owner's exit"
    );
    let resumed = crate::testing::config_store(&path).unwrap();
    let (initial, delivered) = mpsc::channel();
    let recovered_subscription = resumed
        .subscribe_configuration(move |view| {
            initial
                .send((view.change, view.revision, view.config.routing.strategy.clone()))
                .unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(
        receive(&delivered),
        (ConfigurationChange::Initial, old_revision + 1, "fill-first".into())
    );
    let copy = dir.join("resumed-copy.db");
    std::fs::copy(&path, &copy).unwrap();
    let cold = crate::testing::config_store(&copy).unwrap();
    assert_eq!(cold.load().unwrap().config.routing.strategy, "fill-first");
    assert!(rx.try_recv().is_err(), "failed original command never reports success");
    drop((cold, recovered_subscription, resumed));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn required_runtime_views_precede_even_preexisting_change_subscribers() {
    let store = Arc::new(ConfigStore::memory_with("routing: {strategy: round-robin}\n"));
    let rt = Arc::new(crate::testing::runtime(
        store.load().unwrap().config,
        vec![],
        executors(),
    ));
    let weak = Arc::downgrade(&rt);
    let (tx, rx) = mpsc::channel();
    let subscription = store
        .subscribe_configuration(move |view| {
            if view.change == ConfigurationChange::Committed {
                let rt = weak.upgrade().unwrap();
                assert_eq!(rt.config().routing.strategy, view.config.routing.strategy);
                assert_eq!(rt.policy().strategy, crate::management::policy(&view.config).strategy);
                tx.send(view.revision).unwrap();
            }
            Ok(())
        })
        .unwrap();
    let management = crate::management::Management::new(rt.clone(), store.clone());
    let done = store
        .import_yaml("routing: {strategy: fill-first}\n", "test", "")
        .unwrap();
    assert_eq!(receive(&rx), done.rev);
    assert_eq!(management.published_rev(), done.rev);
    drop((subscription, management));
}

fn seed_protocol_credential(f: &Fixture) -> Arc<cpa_core::credential::Credential> {
    let path = f.db.auth_dir().join("protocol.json");
    f.db.save(&path, br#"{"type":"codex","access_token":"T0","refresh_token":"R0"}"#)
        .unwrap();
    let scan = crate::testing::with_builtin_auth_parser(|| {
        f.db.scan(&f.rt.config()).unwrap()
    });
    f.rt.store().reconcile_scanned(scan.credentials, &scan.read);
    f.rt.store()
        .snapshot()
        .into_iter()
        .find(|c| c.str("access_token") == Some("T0"))
        .unwrap()
}
fn protocol_patch(f: &Fixture, credential: &cpa_core::credential::Credential) {
    let mut patch = cpa_core::credential::MetadataPatch::default();
    patch.set.insert("access_token".into(), json!("T1"));
    f.rt.store()
        .apply_patch(&credential.id, credential.revision, &patch)
        .unwrap();
}

#[test]
fn configuration_and_public_credential_patch_complete_coherently() {
    let f = Fixture::new();
    let credential = seed_protocol_credential(&f);
    let (events, received) = mpsc::channel();
    let rt = Arc::downgrade(&f.rt);
    let subscription = f
        .store
        .subscribe_configuration(move |view| {
            let rt = rt.upgrade().unwrap();
            let (cfg, policy) = rt.request_snapshot();
            assert_eq!(crate::management::policy(&cfg).strategy, policy.strategy);
            events.send(view.revision).unwrap();
            Ok(())
        })
        .unwrap();
    receive(&received);
    let (entered, entry) = mpsc::channel();
    let (release, proceed) = mpsc::channel();
    let fault = installation_effects::once(f.store.path().unwrap(), Stage::BeforeReplace, move || {
        entered.send(()).unwrap();
        receive(&proceed);
        Ok(())
    });
    let store = f.store.clone();
    let config = std::thread::spawn(move || store.import_yaml("routing: {strategy: fill-first}\n", "test", ""));
    receive(&entry);
    let (started, starting) = mpsc::channel();
    let (done, completed) = mpsc::channel();
    let rt = f.rt.clone();
    let patch = std::thread::spawn(move || {
        started.send(()).unwrap();
        let mut patch = cpa_core::credential::MetadataPatch::default();
        patch.set.insert("access_token".into(), json!("T1"));
        let result = rt.store().apply_patch(&credential.id, credential.revision, &patch);
        done.send(()).unwrap();
        result
    });
    receive(&starting);
    release.send(()).unwrap();
    receive(&completed);
    let committed = config.join().unwrap().unwrap();
    patch.join().unwrap().unwrap();
    assert_eq!(receive(&received), committed.rev);
    assert!(received.try_recv().is_err());
    assert_eq!(f.rt.config().routing.strategy, "fill-first");
    let scan = crate::testing::with_builtin_auth_parser(|| {
        f.db.scan(&f.rt.config()).unwrap()
    });
    assert_eq!(scan.credentials[0].str("access_token"), Some("T1"));
    assert_eq!(f.rt.store().snapshot()[0].str("access_token"), Some("T1"));
    drop((fault, subscription));
    f.finish();
}

#[test]
fn pending_configuration_recovers_inside_public_credential_patch() {
    let f = Fixture::new();
    let credential = seed_protocol_credential(&f);
    let (tx, rx) = mpsc::channel();
    let subscription = f
        .store
        .subscribe_configuration(move |view| {
            tx.send(view.revision).unwrap();
            Ok(())
        })
        .unwrap();
    let initial = receive(&rx);
    let fault = installation_effects::once(f.store.path().unwrap(), Stage::BeforeReplace, || {
        Err(std::io::Error::other("private publication fault"))
    });
    assert!(
        f.store
            .import_yaml("routing: {strategy: fill-first}\n", "test", "")
            .is_err()
    );
    assert_eq!(f.store.load().unwrap().rev, initial);
    drop(fault);
    protocol_patch(&f, &credential);
    assert_eq!(receive(&rx), initial + 1);
    assert!(
        rx.try_recv().is_err(),
        "credential persistence is not a configuration event"
    );
    assert_eq!(f.rt.config().routing.strategy, "fill-first");
    let copy = f.dir.join("protocol-cold-copy.db");
    std::fs::copy(f.store.path().unwrap(), &copy).unwrap();
    let cold = crate::testing::config_store(&copy).unwrap();
    assert_eq!(cold.load().unwrap().config.routing.strategy, "fill-first");
    drop(cold);
    assert_eq!(
        f.db.scan(&f.rt.config()).unwrap().credentials[0].str("access_token"),
        Some("T1")
    );
    drop(subscription);
    f.finish();
}

#[test]
fn grant_merge_preserves_the_original_incomplete_configuration_event_once() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let f = Fixture::new();
    let fail = Arc::new(AtomicBool::new(true));
    let failed = fail.clone();
    let required = f
        .store
        .install_configuration(move |view| {
            if view.change == ConfigurationChange::Committed && failed.load(Ordering::Acquire) {
                anyhow::bail!("incomplete required projection");
            }
            Ok(())
        })
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let subscription = f
        .store
        .subscribe_configuration(move |view| {
            tx.send((view.revision, view.digest.clone(), view.config.routing.strategy.clone()))
                .unwrap();
            Ok(())
        })
        .unwrap();
    let initial = receive(&rx);
    let mut changes = f.rt.subscribe_config();
    assert!(
        f.store
            .import_yaml("routing: {strategy: fill-first}\n", "test", "original")
            .is_err()
    );
    let advanced = f.store.load().unwrap();
    assert_eq!(advanced.rev, initial.0 + 1);
    assert!(rx.try_recv().is_err());
    let auth = f.db.auth_dir().join("granted.json");
    assert!(
        f.db.granted_command()
            .unwrap()
            .save(&auth, br#"{"refresh_token":"R1","opaque":[1,2]}"#)
            .is_err()
    );
    assert!(rx.try_recv().is_err());
    assert!(changes.try_next().is_none());
    fail.store(false, Ordering::Release);
    f.db.admit_work().unwrap();
    assert_eq!(receive(&rx), (advanced.rev, advanced.digest, "fill-first".into()));
    assert!(rx.try_recv().is_err());
    assert!(changes.try_next().is_some());
    assert_eq!(
        f.db.read(&auth).unwrap().unwrap(),
        br#"{"refresh_token":"R1","opaque":[1,2]}"#
    );
    f.db.save(&auth, br#"{"refresh_token":"R1","opaque":[1,2],"label":"edit"}"#)
        .unwrap();
    assert!(
        rx.try_recv().is_err(),
        "credential-only changes are not configuration events"
    );
    drop((subscription, required));
    f.finish();
}

#[test]
fn required_projection_failure_retains_recovery_and_withholds_ordinary_success() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    for panic in [false, true] {
        let f = Fixture::new();
        let fail = Arc::new(AtomicBool::new(true));
        let attempts = Arc::new(AtomicUsize::new(0));
        let failed = fail.clone();
        let counted = attempts.clone();
        let required = f
            .store
            .install_configuration(move |view| {
                if view.change == ConfigurationChange::Committed {
                    counted.fetch_add(1, Ordering::SeqCst);
                    if failed.load(Ordering::SeqCst) {
                        assert!(!panic, "private required projection panic");
                        anyhow::bail!("private required projection failure");
                    }
                }
                Ok(())
            })
            .unwrap();
        let broken = f
            .store
            .subscribe_configuration(|_| anyhow::bail!("ordinary failure"))
            .unwrap();
        let panicking = f.store.subscribe_configuration(|_| panic!("ordinary panic")).unwrap();
        let (tx, rx) = mpsc::channel();
        let subscriber = f
            .store
            .subscribe_configuration(move |v| {
                tx.send(v.revision).unwrap();
                Ok(())
            })
            .unwrap();
        let initial = receive(&rx);
        let mut runtime_changes = f.rt.subscribe_config();
        assert!(
            f.store
                .import_yaml("routing: {strategy: fill-first}\n", "test", "")
                .is_err(),
            "a durable configuration with incomplete required projection must not be acknowledged"
        );
        assert!(rx.try_recv().is_err());
        assert!(
            runtime_changes.try_next().is_none(),
            "runtime success notification must also wait"
        );
        assert!(f.db.save(&f.db.auth_dir().join("blocked.json"), b"{}").is_err());
        assert!(f.db.read(&f.db.auth_dir().join("blocked.json")).unwrap().is_none());
        let cold_path = f.dir.join("required-failure-cold-copy.db");
        std::fs::copy(f.store.path().unwrap(), &cold_path).unwrap();
        let cold = crate::testing::config_store(&cold_path).unwrap();
        assert_eq!(cold.load().unwrap().config.routing.strategy, "fill-first");
        drop(cold);
        fail.store(false, Ordering::SeqCst);
        let retried = f
            .store
            .import_yaml("routing: {strategy: fill-first}\n", "test", "")
            .unwrap();
        assert!(!retried.written);
        assert_eq!(receive(&rx), initial + 1);
        assert!(runtime_changes.try_next().is_some());
        assert!(rx.try_recv().is_err());
        assert!(attempts.load(Ordering::SeqCst) >= 3);
        let leaked = Arc::new(AtomicUsize::new(0));
        let count = leaked.clone();
        assert!(
            f.store
                .install_configuration(move |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                    assert!(!panic, "initial installation panic");
                    anyhow::bail!("initial installation failure")
                })
                .is_err()
        );
        f.store
            .import_yaml("routing: {strategy: round-robin}\n", "test", "")
            .unwrap();
        assert_eq!(leaked.load(Ordering::SeqCst), 1, "failed registration must unregister");
        let standalone = Arc::new(crate::testing::runtime_with_db(
            Config::parse("").unwrap(),
            vec![],
            executors(),
            f.db.clone(),
        ));
        let runtime = standalone.clone();
        assert!(
            f.store
                .install_configuration(move |_| {
                    runtime.bind_configuration(|| panic!("private initial binding failure"));
                    Ok(())
                })
                .is_err()
        );
        assert!(
            standalone.publish_config(Config::parse("").unwrap()),
            "failed registration must not leave an initially unbound runtime half-bound"
        );
        drop(standalone);
        drop((required, broken, panicking, subscriber));
        f.finish();
    }
}

#[test]
fn destroying_callback_captures_unsubscribes_without_the_list_lock() {
    let f = Fixture::new();
    let a = f.store.subscribe_configuration(|_| Ok(())).unwrap();
    let b = f
        .store
        .subscribe_configuration(move |_| {
            let _ = &a;
            Ok(())
        })
        .unwrap();
    drop(b);
    let (tx, rx) = mpsc::channel();
    let c = f
        .store
        .subscribe_configuration(move |v| {
            tx.send(v.revision).unwrap();
            Ok(())
        })
        .unwrap();
    let initial = receive(&rx);
    let committed = f
        .store
        .import_yaml("routing: {strategy: fill-first}\n", "test", "")
        .unwrap();
    assert_eq!(receive(&rx), committed.rev);
    assert!(committed.rev > initial);
    drop(c);
    f.finish();
}

#[test]
fn management_retries_an_interrupted_projection_before_success_notifications() {
    for tail in [false, true] {
        let f = Fixture::new();
        let (tx, rx) = mpsc::channel();
        let subscriber = f
            .store
            .subscribe_configuration(move |v| {
                tx.send(v.revision).unwrap();
                Ok(())
            })
            .unwrap();
        let initial = receive(&rx);
        let mut changes = f.rt.subscribe_config();
        let _tail = if tail {
            Some(installation_effects::once(
                &f.db.auth_dir(),
                Stage::RuntimeDerivedTail,
                || panic!("interrupted runtime derived tail"),
            ))
        } else {
            crate::management::BEFORE_RECONCILE.lock().unwrap().push((
                f.db.auth_dir(),
                Box::new(|| panic!("interrupted credential projection")),
            ));
            None
        };
        let yaml = "routing: {strategy: fill-first}\napi-keys: {claude: [{keys: [{api-key: private-fixture-key}]}]}\n";
        assert!(f.store.import_yaml(yaml, "test", "").is_err());
        assert_eq!(f.rt.config().routing.strategy, "fill-first");
        assert!(changes.try_next().is_none());
        assert!(rx.try_recv().is_err());
        f.db.save(&f.db.auth_dir().join("recovery.json"), b"{}").unwrap();
        let retried = f.store.load().unwrap();
        assert_eq!(f.management.published_rev(), retried.rev);
        assert_eq!(
            crate::management::policy(&f.rt.config()).strategy,
            f.rt.policy().strategy
        );
        assert!(!f.rt.store().snapshot().is_empty(), "credential projection must finish");
        assert!(changes.try_next().is_some());
        assert_eq!(receive(&rx), initial + 1);
        f.db.save(&f.db.auth_dir().join("recovery.json"), b"{}").unwrap();
        assert!(changes.try_next().is_none());
        assert!(rx.try_recv().is_err());
        drop(subscriber);
        f.finish();
    }
}

#[test]
fn last_management_pin_outlives_admission_and_joins_same_owner_cooldown() {
    struct Observed {
        db: Arc<CredentialDb>,
        entered: mpsc::Sender<()>,
        joined: mpsc::Sender<()>,
    }
    impl Backend for Observed {
        fn load(&self) -> Result<Vec<crate::cooldown_store::Record>, String> {
            self.db.load()
        }
        fn save(&self, records: Vec<crate::cooldown_store::Record>, now: std::time::SystemTime) -> Result<(), String> {
            let _ = self.entered.send(());
            Backend::save(&*self.db, records, now)
        }
    }
    impl Drop for Observed {
        fn drop(&mut self) {
            self.joined.send(()).unwrap();
        }
    }
    for failure in 0..3 {
        let f = Fixture::new();
        let required = f
            .store
            .install_configuration(move |view| {
                if failure == 1 && view.change == ConfigurationChange::Committed {
                    anyhow::bail!("private later adapter error");
                }
                Ok(())
            })
            .unwrap();
        let (entered, waiting) = mpsc::channel();
        let (joined, stopped) = mpsc::channel();
        f.rt.store().set_cooldown_backend(Arc::new(Observed {
            db: f.db.clone(),
            entered,
            joined,
        }));
        let (at_hook, hook_entered) = mpsc::channel();
        let (dropped, drop_done) = mpsc::channel();
        crate::management::BEFORE_RECONCILE.lock().unwrap().push((
            f.db.auth_dir(),
            Box::new(move || {
                receive(&waiting); // Worker has entered a save requiring this command's owner.
                at_hook.send(()).unwrap();
                receive(&drop_done);
                assert_ne!(failure, 2, "private last-owner installation panic");
            }),
        ));
        let Fixture {
            dir,
            store,
            db,
            rt,
            management,
        } = f;
        let weak = Arc::downgrade(&rt);
        let release = std::thread::spawn(move || {
            receive(&hook_entered);
            drop((management, rt));
            dropped.send(()).unwrap();
        });
        let result = store.import_yaml(
            "routing: {strategy: fill-first, cooldown: {save-cooldown-status: true}}\n",
            "test",
            "",
        );
        assert_eq!(result.is_err(), failure != 0);
        release.join().unwrap();
        receive(&stopped); // Last backend reference is released only after Writer joins.
        assert!(weak.upgrade().is_none());
        drop((required, db, store));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn dispatch_pins_unlock_before_error_panic_and_failed_registration_cleanup() {
    struct Pin {
        store: std::sync::Weak<ConfigStore>,
        released: mpsc::Sender<()>,
    }
    impl Drop for Pin {
        fn drop(&mut self) {
            let store = self.store.upgrade().unwrap();
            assert!(
                store.writer.try_lock().is_ok(),
                "component destructor ran inside admission"
            );
            self.released.send(()).unwrap();
        }
    }
    for initial in [false, true] {
        for panic in [false, true] {
            let f = Fixture::new();
            let (released, done) = mpsc::channel();
            let pin = Mutex::new(Some(Arc::new(Pin {
                store: Arc::downgrade(&f.store),
                released,
            })));
            let weak = Arc::downgrade(&f.store);
            let registration = f.store.install_configuration(move |view| {
                if initial || view.change == ConfigurationChange::Committed {
                    if let Some(pin) = pin.lock().unwrap().take() {
                        weak.upgrade().unwrap().pin_configuration_owner(pin);
                    }
                    assert!(!panic, "private pin failure");
                    anyhow::bail!("private pin error");
                }
                Ok(())
            });
            if initial {
                assert!(registration.is_err());
            } else {
                let registration = registration.unwrap();
                assert!(
                    f.store
                        .import_yaml("routing: {strategy: fill-first}\n", "test", "")
                        .is_err()
                );
                drop(registration);
            }
            receive(&done);
            f.store
                .import_yaml("routing: {strategy: round-robin}\n", "test", "")
                .unwrap();
            f.finish();
        }
    }
}

#[test]
fn explicit_shutdown_drains_normalization_queued_behind_the_owner_before_cleanup() {
    use std::future::Future;
    use std::task::Poll;
    let executor = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    executor.block_on(async {
        let f = Fixture::new();
        let credential = seed_protocol_credential(&f);
        let source = match &credential.source {
            cpa_core::credential::Source::File(p) => p.clone(),
            _ => unreachable!(),
        };
        let (committed, observed) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let held = Mutex::new(held);
        let subscription = f
            .store
            .subscribe_configuration(move |view| {
                if view.change == ConfigurationChange::Committed {
                    committed.send(()).unwrap();
                    receive(&held.lock().unwrap());
                }
                Ok(())
            })
            .unwrap();
        let writer = {
            let store = f.store.clone();
            std::thread::spawn(move || {
                store
                    .import_yaml("routing: {strategy: fill-first}\n", "test", "")
                    .unwrap()
            })
        };
        receive(&observed);
        drop(
            f.rt.store()
                .select(crate::runtime::Selection::new("codex", "probe"))
                .unwrap(),
        );
        let mut shutdown = Box::pin(f.rt.shutdown_codex_refreshes());
        std::future::poll_fn(|cx| {
            assert!(
                matches!(shutdown.as_mut().poll(cx), Poll::Pending),
                "shutdown passed a queued normalizer"
            );
            Poll::Ready(())
        })
        .await;
        release.send(()).unwrap();
        writer.join().unwrap();
        shutdown.await;
        let normalized: Json = serde_json::from_slice(&std::fs::read(&source).unwrap()).unwrap();
        assert_eq!(normalized["disabled"], false);
        let weak = Arc::downgrade(f.rt.store());
        let dir = f.dir.clone();
        drop(subscription);
        f.finish();
        assert!(weak.upgrade().is_none(), "normalizer retained the deleted fixture");
        assert!(!dir.exists());
    });
    executor.shutdown_timeout(Duration::from_secs(10));
}
