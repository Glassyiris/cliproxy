//! cooker's main() with one difference: Options.login_base points every provider's
//! login endpoints (Claude, Codex, Kimi, Meta) at a local fake. Test tool, never shipped.
//! Build: cp ../../../Cargo.lock . && CARGO_TARGET_DIR=../../../target cargo build
//! Run:   login-harness <config.yaml> http://127.0.0.1:9102   (see scripts/fake-logins.mjs)
use std::net::SocketAddr;
use std::sync::Arc;

use ck_exec::Executors;
use ck_exec::claude::{ClaudeExecutor, DEFAULT_BASE_URL};
use ck_server::config_store::ConfigStore;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let path = std::path::PathBuf::from(args.next().expect("config path"));
    let login_base = args.next().expect("fake login base URL");
    let store = Arc::new(ConfigStore::memory_with(&std::fs::read_to_string(&path)?));
    let config = store.load().map_err(|e| anyhow::anyhow!("{e}"))?.config;
    let credentials = ck_core::config::credentials::load(&config);
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
    let executors = Executors {
        claude: ClaudeExecutor::new(DEFAULT_BASE_URL)?,
        codex: ck_exec::codex::CodexExecutor::new()?,
        devices: Default::default(),
        openai: Default::default(),
        google: Default::default(),
    };
    // The deny-all test runtime: a credential that is not local cannot leave the machine.
    let rt = Arc::new(ck_server::testing::runtime(config, credentials, executors));
    ck_server::install_registry(&rt);
    let options = ck_server::management::Options {
        login_base: Some(login_base),
        ..Default::default()
    };
    let management = ck_server::management::Management::with_options(rt.clone(), store, options);
    let _watcher = ck_server::watching::start(&management);
    // As main.rs: management answers what the API routes do not, then CORS and the access log.
    let app = ck_server::app(rt.clone(), ck_server::management::router(management))
        .layer(axum::middleware::from_fn(ck_server::management::cors));
    let app = ck_server::observability::router(&rt, app);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}
