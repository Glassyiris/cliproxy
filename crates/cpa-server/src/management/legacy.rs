//! The v0 routes that remain: the `*-auth-url` sign-in starts and the Vertex import,
//! both over their v8 handlers.
use std::sync::Arc;

use axum::extract::{OriginalUri, RawQuery, State};
use axum::response::Response;

use super::Management;

/// v0 `*-auth-url` routes and the provider the v8 handler dispatches them to.
pub(crate) const AUTH_URL_ROUTES: [(&str, &str); 8] = [
    ("anthropic-auth-url", "claude"),
    ("codex-auth-url", "codex"),
    ("antigravity-auth-url", "antigravity"),
    ("kimi-auth-url", "kimi"),
    ("kimi-ai-auth-url", "kimi-ai"),
    ("xai-auth-url", "xai"),
    ("devin-auth-url", "devin"),
    ("meta-auth-url", "meta"),
];

/// v0 `*-auth-url`: the v8 `/oauth/auth-url` handler for that provider.
pub(crate) async fn auth_url(
    State(state): State<Arc<Management>>,
    OriginalUri(uri): OriginalUri,
    RawQuery(raw): RawQuery,
) -> Response {
    let route = uri.path().strip_prefix("/v0/management/").unwrap_or_default();
    let Some((_, provider)) = AUTH_URL_ROUTES.iter().find(|(r, _)| *r == route) else {
        return super::access::not_found();
    };
    let query = match raw.filter(|r| !r.is_empty()) {
        Some(raw) => format!("provider={provider}&{raw}"),
        None => format!("provider={provider}"),
    };
    super::oauth::auth_url(State(state), RawQuery(Some(query))).await
}

/// POST /v0/management/vertex/import: v8 `/oauth/import?provider=vertex`.
pub(crate) async fn vertex_import(
    state: State<Arc<Management>>,
    RawQuery(raw): RawQuery,
    headers: axum::http::HeaderMap,
    read: crate::body_limit::Read,
) -> Response {
    // A `provider` in the query does not matter: the route names it.
    let query = match raw.filter(|r| !r.is_empty()) {
        Some(raw) => format!("provider=vertex&{raw}"),
        None => "provider=vertex".to_owned(),
    };
    super::oauth::import(state, RawQuery(Some(query)), headers, read).await
}
