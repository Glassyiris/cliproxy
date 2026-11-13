//! Only test wiring. Mirrors crates/cooker/src/main.rs (config, credential synthesis,
//! auto-refresh, routes, management, CORS and the access log) except the listener and
//! two hooks: the ephemeral test CA replaces the trust store, and the logical
//! first-party hosts are dialed at 127.0.0.3. The executor still builds its production
//! native and OAuth clients (TLS profile, header order, session caches), including for
//! refresh, and its Go standard-transport clients for other origins. The credential files
//! in CREDENTIALS are saved to the database first, as the management API would.
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use ck_exec::Executors;
use ck_exec::claude::{ClaudeExecutor, DEFAULT_BASE_URL, Hooks};
use ck_server::Runtime;
use wreq::tls::trust::CertStore;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(args.len() == 4, "usage: driver CONFIG TEST_CA CREDENTIALS");
    let config_path = Path::new(&args[1]);
    let store = Arc::new(ck_server::testing::config_store(&config_path.with_extension("db"))?);
    store.import_yaml(&std::fs::read_to_string(config_path)?, "harness", "fixture")?;
    let mut config = store.load().map_err(|e| anyhow::anyhow!("{e}"))?.config;
    let db = ck_server::store::credential_store::CredentialDb::initialize(store.clone())?;
    ck_server::testing::seed_credentials(&db, Path::new(&args[3]));
    config.auth_dir = db.auth_dir();
    let mut credentials = db.scan(&config)?.credentials;
    credentials.extend(ck_core::config::credentials::from_config(&config));
    let upstream: SocketAddr = "127.0.0.3:443".parse()?;
    let hooks = Hooks {
        trust: Some(CertStore::from_pem_stack(std::fs::read(&args[2])?)?),
        resolve: vec![
            ("api.anthropic.com".into(), upstream),
            ("platform.claude.com".into(), upstream),
        ],
    };
    let executors = Executors {
        claude: ClaudeExecutor::with_hooks(hooks, DEFAULT_BASE_URL),
        codex: Default::default(),
        openai: Default::default(),
        google: Default::default(),
        devices: Default::default(),
    };
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
    let rt = Arc::new(Runtime::new(config, credentials, executors, db));
    ck_server::install_registry(&rt);
    rt.start_auto_refresh();
    let management =
        ck_server::management::api::Management::with_options(rt.clone(), store, ck_server::management::api::Options::default());
    let watcher = ck_server::management::watching::start(&management);
    let app = ck_server::app(rt.clone(), ck_server::management::api::router(management.clone()))
        .layer(axum::middleware::from_fn(ck_server::management::api::cors));
    let app = ck_server::observability::api::router(&rt, app);
    // The production listener (crates/cooker uses the same call), plain HTTP.
    let served = ck_server::net::listener::serve_with_resp(listener, app, None, Some(management)).await;
    watcher.shutdown().await?;
    rt.shutdown_codex_refreshes().await;
    served?;
    Ok(())
}
