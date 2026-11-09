//! `/admin/v1`: the config as resources ([`crate::config_store`]).
//!
//! - `GET /r/{kind}`, `GET|PUT|PATCH|DELETE /r/{kind}/{id}`: one resource. The ETag
//!   is its revision; `If-Match` makes a write conditional on it and `If-None-Match: *`
//!   creates only. PATCH is an RFC 7396 merge patch of the spec.
//! - `POST /apply`: several operations, all or none, as one revision
//!   ([`crate::config_store::Op`]).
//! - `GET /effective/config`: the config document the resources compile to, with
//!   `"@id"` on provider and router entries and live `auth_index` values.
//! - `GET /revisions`, `GET /revisions/{rev}`, `POST /revisions/{rev}/restore`.
//! - `GET /export`, `POST /import` (a resource list, or a config file in YAML).
//!
//! Every write takes `?dry_run=true` and `?message=`, and answers the revision, the
//! changes (secrets hidden) and whether a setting read only at startup changed.
//! Responses carry `X-Cook-Revision` (stored) and `X-Cook-Published-Revision` (running).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value as Json, json};

use super::Management;
use crate::config_store::{CommitError, Committed, Kind, Op, Resource, resources};

const ACTOR: &str = "admin-api";

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct WriteQuery {
    dry_run: bool,
    message: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct PageQuery {
    limit: Option<u32>,
    before: Option<u64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct ExportQuery {
    include_secrets: bool,
}

fn send(state: &Management, status: StatusCode, body: &Json) -> Response {
    let mut response = (
        status,
        [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))],
        body.to_string(),
    )
        .into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(head) = state.config.head() {
        headers.insert("x-cook-revision", head.into());
    }
    headers.insert("x-cook-published-revision", state.published_rev().into());
    response
}

fn fail(state: &Management, e: &CommitError) -> Response {
    let status = StatusCode::from_u16(e.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    if status.is_server_error() {
        tracing::error!("admin api: {e}");
    }
    send(
        state,
        status,
        &json!({"error": e.code, "resource": e.fault.resource, "message": e.fault.message}),
    )
}

fn error(state: &Management, status: u16, code: &'static str, message: impl Into<String>) -> Response {
    fail(
        state,
        &CommitError {
            status,
            code,
            fault: crate::config_store::Fault::new(None, message),
        },
    )
}

fn shown(r: &Resource) -> Json {
    let r = resources::for_read(r);
    json!({
        "kind": r.kind,
        "id": r.id,
        "ord": r.ord,
        "rev": r.rev,
        "created_rev": r.created_rev,
        "description": r.description,
        "spec": r.spec,
    })
}

fn etag(rev: u64) -> HeaderValue {
    HeaderValue::try_from(format!("\"{rev}\"")).expect("digits")
}

/// `If-Match: "<rev>"` as the revision a write requires; `*` or none requires none.
fn if_rev(headers: &HeaderMap) -> Result<Option<u64>, ()> {
    let Some(value) = headers.get(header::IF_MATCH) else {
        return Ok(None);
    };
    let text = value.to_str().map_err(drop)?.trim();
    if text == "*" {
        return Ok(None);
    }
    text.trim_matches('"').parse().map(Some).map_err(drop)
}

fn if_absent(headers: &HeaderMap) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim() == "*")
}

fn answer(state: &Management, done: &Committed, restart: bool, resource: Option<&Resource>) -> Response {
    let mut body = json!({
        "revision": done.rev,
        "written": done.written,
        "changes": done.changes,
        "restart_required": restart,
    });
    if let Some(r) = resource {
        body["resource"] = shown(r);
    }
    let mut response = send(state, StatusCode::OK, &body);
    if let Some(r) = resource {
        response.headers_mut().insert(header::ETAG, etag(r.rev));
    }
    response
}

/// Runs `f` off the async runtime.
async fn blocking(state: Arc<Management>, f: impl FnOnce(&Management) -> Response + Send + 'static) -> Response {
    tokio::task::spawn_blocking(move || f(&state))
        .await
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Commits `ops` and answers with the resource `kind/id` as stored after it.
async fn write(state: Arc<Management>, query: WriteQuery, ops: Vec<Op>, target: Option<(Kind, String)>) -> Response {
    blocking(state, move |state| {
        match state.commit_with(|store| store.commit(&ops, ACTOR, &query.message, query.dry_run)) {
            Ok((done, restart)) => {
                let resource = match &target {
                    Some((kind, id)) if done.written => state.config.get(*kind, id).ok().flatten(),
                    _ => None,
                };
                answer(state, &done, restart, resource.as_ref())
            }
            Err(e) => fail(state, &e),
        }
    })
    .await
}

fn kind_of(state: &Management, name: &str) -> Result<Kind, Response> {
    Kind::parse(name).ok_or_else(|| error(state, 404, "unknown_kind", format!("no resource kind {name:?}")))
}

fn json_body<T: serde::de::DeserializeOwned>(state: &Management, body: &[u8]) -> Result<T, Response> {
    serde_json::from_slice(body).map_err(|e| error(state, 400, "invalid_body", e.to_string()))
}

pub(crate) async fn list(State(state): State<Arc<Management>>, Path(kind): Path<String>) -> Response {
    let kind = match kind_of(&state, &kind) {
        Ok(k) => k,
        Err(r) => return r,
    };
    blocking(state, move |state| match state.config.resources() {
        Ok(all) => {
            let items: Vec<Json> = all.iter().filter(|r| r.kind == kind).map(shown).collect();
            send(state, StatusCode::OK, &json!({ "items": items }))
        }
        Err(e) => error(state, 500, "store_failed", format!("{e:#}")),
    })
    .await
}

pub(crate) async fn get(State(state): State<Arc<Management>>, Path((kind, id)): Path<(String, String)>) -> Response {
    let kind = match kind_of(&state, &kind) {
        Ok(k) => k,
        Err(r) => return r,
    };
    blocking(state, move |state| match state.config.get(kind, &id) {
        Ok(Some(r)) => {
            let mut response = send(state, StatusCode::OK, &shown(&r));
            response.headers_mut().insert(header::ETAG, etag(r.rev));
            response
        }
        Ok(None) => error(state, 404, "not_found", format!("no {}/{id}", kind.name())),
        Err(e) => error(state, 500, "store_failed", format!("{e:#}")),
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    spec: Json,
    #[serde(default)]
    ord: Option<i64>,
    #[serde(default)]
    description: Option<String>,
}

pub(crate) async fn put(
    State(state): State<Arc<Management>>,
    Path((kind, id)): Path<(String, String)>,
    Query(query): Query<WriteQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let kind = match kind_of(&state, &kind) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let Ok(if_rev) = if_rev(&headers) else {
        return error(&state, 400, "invalid_if_match", "If-Match must name a revision: \"12\"");
    };
    let body: Body = match json_body(&state, &body) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let op = Op::Put {
        kind: kind.name().into(),
        id: id.clone(),
        spec: body.spec,
        ord: body.ord,
        description: body.description,
        if_rev,
        if_absent: if_absent(&headers),
    };
    write(state, query, vec![op], Some((kind, id))).await
}

pub(crate) async fn patch(
    State(state): State<Arc<Management>>,
    Path((kind, id)): Path<(String, String)>,
    Query(query): Query<WriteQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let kind = match kind_of(&state, &kind) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let Ok(if_rev) = if_rev(&headers) else {
        return error(&state, 400, "invalid_if_match", "If-Match must name a revision: \"12\"");
    };
    let patch: Json = match json_body(&state, &body) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let op = Op::Patch {
        kind: kind.name().into(),
        id: id.clone(),
        patch,
        if_rev,
    };
    write(state, query, vec![op], Some((kind, id))).await
}

pub(crate) async fn delete(
    State(state): State<Arc<Management>>,
    Path((kind, id)): Path<(String, String)>,
    Query(query): Query<WriteQuery>,
    headers: HeaderMap,
) -> Response {
    let kind = match kind_of(&state, &kind) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let Ok(if_rev) = if_rev(&headers) else {
        return error(&state, 400, "invalid_if_match", "If-Match must name a revision: \"12\"");
    };
    let op = Op::Delete {
        kind: kind.name().into(),
        id,
        if_rev,
    };
    write(state, query, vec![op], None).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Apply {
    ops: Vec<Op>,
    #[serde(default)]
    message: String,
    #[serde(default)]
    dry_run: bool,
}

pub(crate) async fn apply(State(state): State<Arc<Management>>, body: Bytes) -> Response {
    let apply: Apply = match json_body(&state, &body) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let query = WriteQuery {
        dry_run: apply.dry_run,
        message: apply.message,
    };
    write(state, query, apply.ops, None).await
}

pub(crate) async fn effective_config(State(state): State<Arc<Management>>) -> Response {
    blocking(state, |state| {
        let all = match state.config.resources() {
            Ok(all) => all,
            Err(e) => return error(state, 500, "store_failed", format!("{e:#}")),
        };
        let mut doc = resources::document_for_read(&all);
        // The indexes the dashboard joins credentials on; writes drop them again.
        if let Ok((cfg, _)) = resources::config(&all) {
            super::auth_index::inject(&mut doc, &cfg, &super::live_auth_indexes(state));
        }
        send(state, StatusCode::OK, &doc)
    })
    .await
}

pub(crate) async fn revisions(State(state): State<Arc<Management>>, Query(page): Query<PageQuery>) -> Response {
    blocking(state, move |state| {
        let limit = page.limit.unwrap_or(50).clamp(1, 500);
        match state.config.revisions(limit, page.before) {
            Ok(list) => send(state, StatusCode::OK, &json!({ "revisions": list })),
            Err(e) => error(state, 500, "store_failed", format!("{e:#}")),
        }
    })
    .await
}

pub(crate) async fn revision(State(state): State<Arc<Management>>, Path(rev): Path<u64>) -> Response {
    blocking(state, move |state| match state.config.revision(rev) {
        Ok(Some((revision, changes))) => send(
            state,
            StatusCode::OK,
            &json!({ "revision": revision, "changes": changes }),
        ),
        Ok(None) => error(state, 404, "not_found", format!("no revision {rev}")),
        Err(e) => error(state, 500, "store_failed", format!("{e:#}")),
    })
    .await
}

/// Makes the config what it was after `rev`, as a new revision. History keeps no
/// secrets, so each secret is the one the same resource holds now; a resource whose
/// secret is gone fails with 422 naming it.
pub(crate) async fn restore(
    State(state): State<Arc<Management>>,
    Path(rev): Path<u64>,
    Query(query): Query<WriteQuery>,
) -> Response {
    blocking(state, move |state| {
        let then = match state.config.state_at(rev) {
            Ok(then) => then,
            Err(e) => return error(state, 404, "not_found", format!("{e:#}")),
        };
        let message = if query.message.is_empty() {
            format!("restore revision {rev}")
        } else {
            query.message
        };
        match state.commit_with(|store| store.replace(then, ACTOR, &message, query.dry_run)) {
            Ok((done, restart)) => answer(state, &done, restart, None),
            Err(e) => fail(state, &e),
        }
    })
    .await
}

pub(crate) async fn export(State(state): State<Arc<Management>>, Query(query): Query<ExportQuery>) -> Response {
    blocking(state, move |state| {
        let all = match state.config.resources() {
            Ok(all) => all,
            Err(e) => return error(state, 500, "store_failed", format!("{e:#}")),
        };
        if query.include_secrets {
            tracing::warn!("admin api: config exported with secrets");
        }
        let items: Vec<Json> = all
            .iter()
            .map(|r| {
                let r = if query.include_secrets {
                    r.clone()
                } else {
                    resources::redacted(r)
                };
                json!({"kind": r.kind, "id": r.id, "ord": r.ord, "description": r.description, "spec": r.spec})
            })
            .collect();
        let head = state.config.head().unwrap_or_default();
        send(
            state,
            StatusCode::OK,
            &json!({"format": "cook-router-config", "version": 1, "revision": head, "resources": items}),
        )
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Imported {
    kind: String,
    id: String,
    #[serde(default)]
    ord: i64,
    #[serde(default)]
    description: String,
    spec: Json,
}

#[derive(Deserialize)]
struct Export {
    resources: Vec<Imported>,
}

/// Replaces the whole config: with an export (`application/json`), where a hidden
/// secret keeps the value stored now, or with a config file (any other type).
pub(crate) async fn import(
    State(state): State<Arc<Management>>,
    Query(query): Query<WriteQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.trim_start().starts_with("application/json"));
    let parsed = if json {
        let export: Export = match json_body(&state, &body) {
            Ok(b) => b,
            Err(r) => return r,
        };
        let mut out = Vec::with_capacity(export.resources.len());
        for item in export.resources {
            let Some(kind) = Kind::parse(&item.kind) else {
                return error(&state, 422, "unknown_kind", format!("no resource kind {:?}", item.kind));
            };
            let mut r = Resource::new(kind, item.id, item.ord, item.spec);
            r.description = item.description;
            out.push(r);
        }
        out
    } else {
        let Ok(text) = std::str::from_utf8(&body) else {
            return error(&state, 400, "invalid_body", "a config file must be UTF-8");
        };
        match resources::import_yaml(text) {
            Ok(r) => r,
            Err(e) => return error(&state, 422, "invalid_config", format!("{e:#}")),
        }
    };
    blocking(state, move |state| {
        let message = if query.message.is_empty() {
            "import".to_owned()
        } else {
            query.message
        };
        match state.commit_with(|store| store.replace(parsed, ACTOR, &message, query.dry_run)) {
            Ok((done, restart)) => answer(state, &done, restart, None),
            Err(e) => fail(state, &e),
        }
    })
    .await
}
