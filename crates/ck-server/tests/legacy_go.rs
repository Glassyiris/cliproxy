//! Retained v0 authentication, import and log aliases share their v8 handlers.
use std::net::SocketAddr;
use std::sync::Arc;

use ck_exec::Executors;
use ck_exec::claude::ClaudeExecutor;
use ck_server::management::api::{self as management, Management, Options};
use ck_server::store::config_store::ConfigStore;
use serde_json::Value;

async fn serve() -> (String, tokio::task::JoinHandle<()>) {
    let yaml = "config-version: 8\nmanagement:\n  secret-key: fake-secret\n".to_owned();
    let store = Arc::new(ConfigStore::memory_with(&yaml));
    let config = store.load().unwrap().config;
    let rt = Arc::new(ck_server::testing::runtime(
        config,
        vec![],
        Executors {
            claude: ClaudeExecutor::new("http://127.0.0.1:1").unwrap(),
            codex: Default::default(),
            devices: Default::default(),
            openai: Default::default(),
            google: Default::default(),
        },
    ));
    let state = Management::with_options(
        rt,
        store,
        Options {
            management_password: Some(String::new()),
            // Device sign-in flows use a closed local port, never a provider.
            login_base: Some("http://127.0.0.1:1".into()),
            ..Options::default()
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = management::router(state).layer(axum::middleware::from_fn(
        |mut req: axum::extract::Request, next: axum::middleware::Next| async move {
            req.extensions_mut()
                .insert(axum::extract::ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 1))));
            next.run(req).await
        },
    ));
    (
        base,
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
    )
}

#[tokio::test]
async fn v0_auth_import_and_log_aliases_match_v8() {
    let (base, server) = serve().await;
    let client = wreq::Client::new();
    let get = |method: &str, path: &str| {
        client
            .request(method.parse::<wreq::Method>().unwrap(), format!("{base}{path}"))
            .bearer_auth("fake-secret")
            .send()
    };
    let mut started = Vec::new();
    for path in [
        "/v0/management/antigravity-auth-url",
        "/v8/management/oauth/auth-url?provider=antigravity",
    ] {
        let v: Value = get("GET", path).await.unwrap().json().await.unwrap();
        let state = v["state"].as_str().unwrap();
        started.push((v["status"].clone(), v["url"].as_str().unwrap().replace(state, "STATE")));
    }
    assert_eq!(started[0], started[1]);
    assert_eq!(started[0].0, "ok");
    for (v0, v8) in [
        (
            "/v0/management/xai-auth-url?is_webui=true",
            "/v8/management/oauth/auth-url?provider=xai&is_webui=true",
        ),
        (
            "/v0/management/devin-auth-url",
            "/v8/management/oauth/auth-url?provider=devin",
        ),
        ("/v0/management/logs", "/v8/management/observability/logs"),
        (
            "/v0/management/request-error-logs",
            "/v8/management/observability/logs/errors",
        ),
        (
            "/v0/management/request-log-by-id/nope",
            "/v8/management/observability/logs/requests/nope",
        ),
    ] {
        let (a, b) = (get("GET", v0).await.unwrap(), get("GET", v8).await.unwrap());
        assert_eq!(a.status(), b.status(), "{v0}");
        assert_eq!(a.text().await.unwrap(), b.text().await.unwrap(), "{v0}");
    }
    let (a, b) = (
        get("POST", "/v0/management/vertex/import").await.unwrap(),
        get("POST", "/v8/management/oauth/import?provider=vertex")
            .await
            .unwrap(),
    );
    assert_eq!(
        (a.status(), a.text().await.unwrap()),
        (b.status(), b.text().await.unwrap())
    );
    server.abort();
}
