//! Only test wiring. Mirrors crates/cook-router/src/main.rs (config, credential synthesis,
//! auto-refresh, routes, management, CORS and the access log) except the listener and
//! two hooks: the ephemeral test CA replaces the trust store, and the logical
//! first-party hosts are dialed at 127.0.0.3. The executor still builds its production
//! native and OAuth clients (TLS profile, header order, session caches), including for
//! refresh, and its Go standard-transport clients for other origins.
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use cpa_exec::Executors;
use cpa_exec::claude::{ClaudeExecutor, DEFAULT_BASE_URL, Hooks};
use cpa_server::Runtime;
use wreq::tls::trust::CertStore;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(args.len() == 3, "usage: driver CONFIG TEST_CA");
    let config_path = Path::new(&args[1]);
    let store = Arc::new(cpa_server::testing::config_store(&config_path.with_extension("db"))?);
    store.import_yaml(&std::fs::read_to_string(config_path)?, "harness", "fixture")?;
    let mut config = store.load().map_err(|e| anyhow::anyhow!("{e}"))?.config;
    let db = cpa_server::credential_store::CredentialDb::initialize(store.clone(), &config.auth_dir)?;
    config.auth_dir = db.auth_dir();
    let mut credentials = db.scan(&config)?.credentials;
    credentials.extend(cpa_core::config::credentials::from_config(&config));
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
    cpa_server::install_registry(&rt);
    rt.start_auto_refresh();
    let management =
        cpa_server::management::Management::with_options(rt.clone(), store, cpa_server::management::Options::default());
    let _watcher = cpa_server::watching::start(&management);
    let app = cpa_server::app(rt.clone(), cpa_server::management::router(management.clone()))
        .layer(axum::middleware::from_fn(cpa_server::management::cors));
    let app = cpa_server::observability::router(&rt, app);
    // The production listener (crates/cook-router uses the same call), plain HTTP.
    cpa_server::listener::serve_with_resp(listener, app, None, Some(management)).await?;
    Ok(())
}
