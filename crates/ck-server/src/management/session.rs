//! Dashboard sessions: the management key is exchanged once for an `HttpOnly` cookie, so the
//! browser keeps no key where page scripts can read it. The TUI and CLI keep sending the key.
//!
//! - `POST /v8/management/session` checks the key exactly as [`super::access::guard`] does
//!   (ban, remote policy, failure counting) and sets the cookie for 7 days, or 30 with
//!   `{"remember": true}`. `path` scopes the cookie to the dashboard's base path behind a
//!   reverse-proxy prefix.
//! - `GET` answers 204 for a live session and 401 otherwise without counting a failure, so
//!   loading the dashboard signed out cannot ban the address.
//! - `DELETE` revokes the session and clears the cookie.
//!
//! The cookie holds a random id; the record (absolute expiry on the monotonic clock, scope)
//! stays on the server. Records live in memory only: a restart signs every dashboard out, and
//! live ids never reach the database snapshot or its backups. Publishing a different
//! `management.secret-key`, or removing it, drops every record, so restoring the old secret
//! later revives none; a sign-in checked against a secret replaced meanwhile gets no session.
//! `COOK_MANAGEMENT_PASSWORD` and the local password are read once at startup and cannot change
//! while sessions live.
//!
//! The cookie is `SameSite=Strict`, so browsers attach it to same-site requests only. Every
//! cookie request, whatever its method, must also prove it came from the dashboard
//! ([`refusal`]): some reads have side effects, such as `oauth/auth-url` starting a sign-in or
//! `usage/queue` consuming records. Fetch metadata and `Origin` refuse another origin on the
//! same site (another port or subdomain) when the browser sends them, but browsers omit
//! `Sec-Fetch-*` towards plain-HTTP origins and `Origin` on an image's GET. So the dashboard
//! also sends [`DASHBOARD`] on every request: an image, form or navigation cannot carry it,
//! and another origin's script can add it only after a CORS preflight, which a credentialed
//! request fails because management answers allow `*` origins, list headers only as the `*`
//! wildcard that does not apply to credentialed requests, and never send
//! `Access-Control-Allow-Credentials`. The same answers keep any other origin from reading a
//! response to a request that carried the cookie. A command-line client sends the key instead.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ck_core::config::Config;
use sha2::{Digest, Sha256};

use super::access::{provided_key, version_headers};
use super::{Management, json_error};

pub(crate) const COOKIE: &str = "cook_router_session";
const SHORT: Duration = Duration::from_secs(7 * 24 * 3600);
const LONG: Duration = Duration::from_secs(30 * 24 * 3600);
/// `{"remember": true, "path": "/..."}` with room to spare.
const BODY_LIMIT: usize = 4096;
const PATH_LIMIT: usize = 256;
pub(crate) const EXPIRED: &str = "invalid or expired session";
pub(crate) const CROSS_SITE: &str = "cross-site request refused";
/// The header the dashboard sends with every management request; see the module comment.
pub(crate) const DASHBOARD: &str = "X-Cook-Dashboard";
pub(crate) const NOT_DASHBOARD: &str = "session cookie accepted only from the dashboard";
const SECRET_CHANGED: &str = "management key changed during sign-in; sign in again";

struct Record {
    expires: Instant,
    path: String,
}

struct Inner {
    /// SHA-256 of the published `management.secret-key`; every record was issued under it.
    secret: [u8; 32],
    /// Live sessions by the SHA-256 of their id, so a lookup compares digests rather than ids.
    records: HashMap<[u8; 32], Record>,
}

pub(crate) struct Sessions(Mutex<Inner>);

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

impl Sessions {
    pub(super) fn new(cfg: &Config) -> Self {
        Self(Mutex::new(Inner {
            secret: digest(cfg.management.secret_key.as_bytes()),
            records: HashMap::new(),
        }))
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A published config: a different secret ends every session for good. [`Self::issue`]
    /// compares under the same lock, so no session issued under the old secret survives.
    pub(super) fn config_published(&self, cfg: &Config) {
        let secret = digest(cfg.management.secret_key.as_bytes());
        let mut inner = self.inner();
        if inner.secret != secret {
            inner.secret = secret;
            inner.records.clear();
        }
    }

    /// A new session id, 256 bits from the operating system's CSPRNG, or none when `cfg`, the
    /// config the key was checked against, no longer holds the published secret.
    fn issue(&self, cfg: &Config, lifetime: Duration, path: String, now: Instant) -> Option<String> {
        let mut inner = self.inner();
        if inner.secret != digest(cfg.management.secret_key.as_bytes()) {
            return None;
        }
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("system randomness");
        let id = URL_SAFE_NO_PAD.encode(bytes);
        inner.records.insert(
            digest(id.as_bytes()),
            Record {
                expires: now + lifetime,
                path,
            },
        );
        Some(id)
    }

    /// Whether any of `ids` names a live session and `cfg` holds the published secret.
    /// Records found expired are dropped.
    pub(super) fn valid(&self, cfg: &Config, ids: &[&str], now: Instant) -> bool {
        let mut inner = self.inner();
        if inner.secret != digest(cfg.management.secret_key.as_bytes()) {
            return false;
        }
        ids.iter().any(|id| {
            let key = digest(id.as_bytes());
            let Some(record) = inner.records.get(&key) else {
                return false;
            };
            let live = now < record.expires;
            if !live {
                inner.records.remove(&key);
            }
            live
        })
    }

    /// Ends the sessions `ids` name; returns the cookie path of the first one found.
    fn revoke(&self, ids: &[&str]) -> Option<String> {
        let mut inner = self.inner();
        ids.iter()
            .filter_map(|id| inner.records.remove(&digest(id.as_bytes())))
            .map(|record| record.path)
            .reduce(|first, _| first)
    }

    /// Drops expired records; runs from the hourly purge.
    pub(super) fn purge(&self, now: Instant) {
        self.inner().records.retain(|_, record| now < record.expires);
    }
}

/// Every value of the session cookie in the request, most specific path first as browsers
/// send them. HTTP/2 may split cookies over several headers.
pub(crate) fn cookie_ids(headers: &HeaderMap) -> Vec<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().strip_prefix(COOKIE)?.strip_prefix('='))
        .filter(|id| !id.is_empty())
        .collect()
}

/// The first value of a comma-separated forwarding header.
fn forwarded<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let value = headers.get(name)?.to_str().ok()?;
    Some(value.split(',').next().unwrap_or_default().trim()).filter(|v| !v.is_empty())
}

/// The host the browser addressed: a trusted proxy's `X-Forwarded-Host`, else `Host`, else
/// the HTTP/2 authority.
fn request_host<'a>(headers: &'a HeaderMap, uri: &'a Uri, trusted_proxy: bool) -> Option<&'a str> {
    trusted_proxy
        .then(|| forwarded(headers, "X-Forwarded-Host"))
        .flatten()
        .or_else(|| headers.get(header::HOST).and_then(|v| v.to_str().ok()))
        .or_else(|| uri.authority().map(|a| a.as_str()))
}

/// A browser request another origin started: `Sec-Fetch-Site` present and not
/// `same-origin`, or an `Origin` whose host differs from the one addressed. A request with
/// neither header passes here; browsers send `Sec-Fetch-Site` to HTTPS and loopback origins,
/// and `Origin` on every state-changing fetch.
pub(crate) fn cross_site(headers: &HeaderMap, uri: &Uri, trusted_proxy: bool) -> bool {
    if let Some(site) = headers.get("Sec-Fetch-Site")
        && site.as_bytes() != b"same-origin"
    {
        return true;
    }
    let Some(origin) = headers.get(header::ORIGIN) else {
        return false;
    };
    let origin_host = origin
        .to_str()
        .ok()
        .and_then(|o| o.split_once("://"))
        .map(|(_, host)| host);
    match (origin_host, request_host(headers, uri, trusted_proxy)) {
        (Some(origin), Some(host)) => !origin.eq_ignore_ascii_case(host),
        _ => true,
    }
}

/// Why a cookie-authenticated request is refused (403, never counted): another origin started
/// it, or it lacks [`DASHBOARD`], the evidence that the dashboard's own script sent it.
pub(crate) fn refusal(headers: &HeaderMap, uri: &Uri, trusted_proxy: bool) -> Option<&'static str> {
    if cross_site(headers, uri, trusted_proxy) {
        Some(CROSS_SITE)
    } else if !headers.contains_key(DASHBOARD) {
        Some(NOT_DASHBOARD)
    } else {
        None
    }
}

/// HTTPS as the browser sees it: this listener's own TLS, or a trusted proxy's
/// `X-Forwarded-Proto: https`. An untrusted peer's forwarding headers are ignored.
fn https(req: &axum::http::request::Parts, trusted_proxy: bool) -> bool {
    req.extensions.get::<crate::listener::Tls>().is_some()
        || trusted_proxy
            && forwarded(&req.headers, "X-Forwarded-Proto").is_some_and(|p| p.eq_ignore_ascii_case("https"))
}

/// A cookie path the dashboard sent: its base path, absolute, printable ASCII without `;`.
fn cookie_path(path: Option<String>) -> Option<String> {
    let path = path.unwrap_or_else(|| "/".into());
    (path.starts_with('/') && path.len() <= PATH_LIMIT && path.bytes().all(|b| b.is_ascii_graphic() && b != b';'))
        .then_some(path)
}

fn set_cookie(value: &str, path: &str, max_age: Duration, secure: bool) -> HeaderValue {
    let secure = if secure { "; Secure" } else { "" };
    let cookie = format!(
        "{COOKIE}={value}; Path={path}; Max-Age={}; HttpOnly; SameSite=Strict{secure}",
        max_age.as_secs()
    );
    HeaderValue::try_from(cookie).expect("cookie text is visible ASCII")
}

/// One answer with the version headers every management answer carries.
fn answer(mut response: Response) -> Response {
    version_headers(response.headers_mut());
    response
}

fn signed(cookie: HeaderValue) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    let headers = response.headers_mut();
    headers.insert(header::SET_COOKIE, cookie);
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    answer(response)
}

struct Caller {
    ip: String,
    local: bool,
    trusted_proxy: bool,
}

fn caller(state: &Management, parts: &axum::http::request::Parts) -> Caller {
    let peer = parts.extensions.get::<ConnectInfo<std::net::SocketAddr>>().map(|c| c.0);
    let ip = state.access.client_ip(peer, &parts.headers);
    Caller {
        local: ip == "127.0.0.1" || ip == "::1",
        ip,
        trusted_proxy: state.access.trusts(peer),
    }
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct SignIn {
    remember: bool,
    path: Option<String>,
}

/// `POST`: the key, from the same headers as every management request, for a cookie.
pub(super) async fn create(State(state): State<Arc<Management>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let from = caller(&state, &parts);
    if cross_site(&parts.headers, &parts.uri, from.trusted_proxy) {
        return answer(json_error(StatusCode::FORBIDDEN, CROSS_SITE));
    }
    let cfg = state.rt.config();
    let key = provided_key(&parts.headers);
    if let Err((status, message)) = state
        .access
        .authenticate(&cfg, &from.ip, from.local, key, &state.work)
        .await
    {
        return answer(json_error(status, &message));
    }
    let request = match axum::body::to_bytes(body, BODY_LIMIT).await {
        Ok(bytes) if bytes.is_empty() => Ok(SignIn::default()),
        Ok(bytes) => serde_json::from_slice::<SignIn>(&bytes).map_err(|_| ()),
        Err(_) => Err(()),
    };
    let Some((remember, path)) = request.ok().and_then(|r| Some((r.remember, cookie_path(r.path)?))) else {
        return answer(json_error(StatusCode::BAD_REQUEST, "invalid session request"));
    };
    let lifetime = if remember { LONG } else { SHORT };
    // Signing in again replaces the session this browser held.
    state.access.sessions.revoke(&cookie_ids(&parts.headers));
    let Some(id) = state
        .access
        .sessions
        .issue(&cfg, lifetime, path.clone(), Instant::now())
    else {
        return answer(json_error(StatusCode::CONFLICT, SECRET_CHANGED));
    };
    signed(set_cookie(&id, &path, lifetime, https(&parts, from.trusted_proxy)))
}

/// `GET`: 204 while the cookie names a live session.
pub(super) async fn check(State(state): State<Arc<Management>>, req: Request) -> Response {
    let (parts, _) = req.into_parts();
    let from = caller(&state, &parts);
    let cfg = state.rt.config();
    if let Some(refused) = refusal(&parts.headers, &parts.uri, from.trusted_proxy) {
        return answer(json_error(StatusCode::FORBIDDEN, refused));
    }
    let ids = cookie_ids(&parts.headers);
    match state.access.authenticate_session(&cfg, &from.ip, from.local, &ids) {
        Ok(()) => answer(StatusCode::NO_CONTENT.into_response()),
        Err((status, message)) => answer(json_error(status, &message)),
    }
}

/// `DELETE`: revokes the session and clears the cookie, whether or not it was still live.
pub(super) async fn revoke(State(state): State<Arc<Management>>, req: Request) -> Response {
    let (parts, _) = req.into_parts();
    let from = caller(&state, &parts);
    if let Some(refused) = refusal(&parts.headers, &parts.uri, from.trusted_proxy) {
        return answer(json_error(StatusCode::FORBIDDEN, refused));
    }
    let path = state
        .access
        .sessions
        .revoke(&cookie_ids(&parts.headers))
        .unwrap_or_else(|| "/".into());
    signed(set_cookie("", &path, Duration::ZERO, https(&parts, from.trusted_proxy)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(secret: &str) -> Config {
        let mut cfg = Config::default();
        cfg.management.secret_key = secret.into();
        cfg
    }

    #[test]
    fn a_session_ends_at_its_absolute_expiry() {
        let sessions = Sessions::new(&cfg("hash"));
        let now = Instant::now();
        let id = sessions.issue(&cfg("hash"), SHORT, "/".into(), now).unwrap();
        assert!(URL_SAFE_NO_PAD.decode(&id).unwrap().len() * 8 >= 128);
        assert!(sessions.valid(&cfg("hash"), &[&id], now + SHORT - Duration::from_secs(1)));
        assert!(!sessions.valid(&cfg("hash"), &[&id], now + SHORT));
        // Dropped once seen expired: an earlier instant does not revive it.
        assert!(!sessions.valid(&cfg("hash"), &[&id], now));
    }

    #[test]
    fn the_hourly_purge_drops_only_expired_sessions() {
        let sessions = Sessions::new(&cfg("hash"));
        let now = Instant::now();
        let short = sessions.issue(&cfg("hash"), SHORT, "/".into(), now).unwrap();
        let long = sessions.issue(&cfg("hash"), LONG, "/".into(), now).unwrap();
        sessions.purge(now + SHORT);
        assert_eq!(sessions.inner().records.len(), 1);
        assert!(!sessions.valid(&cfg("hash"), &[&short], now));
        assert!(sessions.valid(&cfg("hash"), &[&long], now));
    }

    #[test]
    fn a_published_secret_change_ends_sessions_for_good() {
        let sessions = Sessions::new(&cfg("a"));
        let now = Instant::now();
        let id = sessions.issue(&cfg("a"), SHORT, "/".into(), now).unwrap();
        assert!(
            !sessions.valid(&cfg("b"), &[&id], now),
            "a request that read another secret"
        );
        // Another field changed: the secret did not, the session stays.
        sessions.config_published(&cfg("a"));
        assert!(sessions.valid(&cfg("a"), &[&id], now));
        // Rotated, then restored without the session being used in between.
        sessions.config_published(&cfg("b"));
        sessions.config_published(&cfg("a"));
        assert!(!sessions.valid(&cfg("a"), &[&id], now));
    }

    #[test]
    fn a_sign_in_checked_against_a_replaced_secret_gets_no_session() {
        let sessions = Sessions::new(&cfg("a"));
        sessions.config_published(&cfg("b"));
        // The key was checked against `a`, read before `b` was published.
        assert_eq!(sessions.issue(&cfg("a"), SHORT, "/".into(), Instant::now()), None);
        assert!(sessions.inner().records.is_empty());
    }

    #[test]
    fn cookie_values_are_read_from_every_cookie_header() {
        let mut headers = HeaderMap::new();
        headers.append(header::COOKIE, "theme=dark; cook_router_session=a".parse().unwrap());
        headers.append(
            header::COOKIE,
            "cook_router_sessionx=b;cook_router_session=c; cook_router_session="
                .parse()
                .unwrap(),
        );
        assert_eq!(cookie_ids(&headers), ["a", "c"]);
    }

    #[test]
    fn only_same_origin_browser_requests_pass() {
        let uri: Uri = "/v8/management/session".parse().unwrap();
        let check = |pairs: &[(&'static str, &str)], trusted| {
            let mut h = HeaderMap::new();
            for (k, v) in pairs {
                h.append(*k, v.parse().unwrap());
            }
            cross_site(&h, &uri, trusted)
        };
        assert!(
            !check(&[("host", "127.0.0.1:8317")], false),
            "curl sends neither header"
        );
        assert!(!check(&[("sec-fetch-site", "same-origin")], false));
        assert!(check(&[("sec-fetch-site", "same-site")], false));
        assert!(check(&[("sec-fetch-site", "cross-site")], false));
        assert!(check(&[("sec-fetch-site", "none")], false));
        let origin = |o: &str, extra: &[(&'static str, &str)], trusted| {
            let mut pairs = vec![("host", "router.example:8317"), ("origin", o)];
            pairs.extend_from_slice(extra);
            check(&pairs, trusted)
        };
        assert!(!origin("http://router.example:8317", &[], false));
        assert!(!origin("https://ROUTER.example:8317", &[], false));
        assert!(origin("http://router.example:3000", &[], false));
        assert!(origin("http://evil.example", &[], false));
        assert!(origin("null", &[], false));
        // A proxy's X-Forwarded-Host counts only from a trusted proxy.
        let proxied = [("x-forwarded-host", "public.example")];
        assert!(!origin("https://public.example", &proxied, true));
        assert!(origin("https://public.example", &proxied, false));
    }

    #[test]
    fn cookie_requests_need_the_dashboard_header() {
        let uri: Uri = "/v8/management/session".parse().unwrap();
        let refused = |pairs: &[(&'static str, &str)]| {
            let mut h = HeaderMap::new();
            for (k, v) in pairs {
                h.append(*k, v.parse().unwrap());
            }
            refusal(&h, &uri, false)
        };
        // An image's GET over plain HTTP: no fetch metadata, no Origin.
        assert_eq!(refused(&[("host", "127.0.0.1:8317")]), Some(NOT_DASHBOARD));
        assert_eq!(refused(&[("x-cook-dashboard", "1")]), None);
        assert_eq!(
            refused(&[("x-cook-dashboard", "1"), ("sec-fetch-site", "same-site")]),
            Some(CROSS_SITE)
        );
    }

    #[test]
    fn secure_follows_tls_or_a_trusted_proxy_only() {
        let parts = |proto: Option<&str>, tls: bool| {
            let mut req = axum::http::Request::new(());
            if let Some(proto) = proto {
                req.headers_mut().insert("x-forwarded-proto", proto.parse().unwrap());
            }
            if tls {
                req.extensions_mut().insert(crate::listener::Tls);
            }
            req.into_parts().0
        };
        assert!(!https(&parts(None, false), true));
        assert!(https(&parts(None, true), false));
        assert!(https(&parts(Some("https"), false), true));
        assert!(!https(&parts(Some("https"), false), false));
        assert!(!https(&parts(Some("http"), false), true));
    }

    #[test]
    fn cookie_paths_are_absolute_and_cannot_add_attributes() {
        assert_eq!(cookie_path(None).as_deref(), Some("/"));
        assert_eq!(cookie_path(Some("/router/".into())).as_deref(), Some("/router/"));
        for bad in ["router/", "/a; Domain=evil.example", "/a b", "/\u{e9}", ""] {
            assert_eq!(cookie_path(Some(bad.into())), None, "{bad}");
        }
        assert_eq!(cookie_path(Some(format!("/{}", "a".repeat(PATH_LIMIT)))), None);
    }
}
