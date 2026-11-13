//! Store authentication (internal/pluginstore/auth.go): `plugins.store-auth` rules
//! that add credentials to matching store requests.

use super::registry::{INSTALL_TYPE_DIRECT, INSTALL_TYPE_GITHUB_RELEASE, Plugin, Source, github_repository_parts};
use super::url;
use super::{REQUEST_KIND_ARTIFACT, REQUEST_KIND_METADATA, REQUEST_KIND_REGISTRY};
use cpa_core::gostr::GoStr;

pub const AUTH_TYPE_NONE: &str = "none";
pub const AUTH_TYPE_BEARER: &str = "bearer";
pub const AUTH_TYPE_BASIC: &str = "basic";
pub const AUTH_TYPE_HEADER: &str = "header";
pub const AUTH_TYPE_GITHUB_TOKEN: &str = "github-token";

/// One `plugins.store-auth` rule. Secrets are named by environment variable.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthConfig {
    pub matches: String,
    pub apply_to: Vec<String>,
    pub auth_type: String,
    pub token_env: String,
    pub username_env: String,
    pub password_env: String,
    pub header_name: String,
    pub header_value_env: String,
    pub allow_insecure: bool,
}

/// Go `NormalizeAuthConfigs`: trimmed, `none` by default, rules without a match
/// dropped, `apply-to` lower-cased and deduplicated.
pub fn normalize_auth_configs(auth: &[AuthConfig]) -> Vec<AuthConfig> {
    auth.iter()
        .filter_map(|item| {
            let mut item = item.clone();
            item.matches = item.matches.trim().into();
            item.auth_type = item.auth_type.trim().go_lower();
            for field in [
                &mut item.token_env,
                &mut item.username_env,
                &mut item.password_env,
                &mut item.header_name,
                &mut item.header_value_env,
            ] {
                *field = field.trim().into();
            }
            if item.auth_type.is_empty() {
                item.auth_type = AUTH_TYPE_NONE.into();
            }
            if item.matches.is_empty() {
                return None;
            }
            let mut apply_to: Vec<String> = Vec::new();
            for value in &item.apply_to {
                let value = value.trim().go_lower();
                if !value.is_empty() && !apply_to.contains(&value) {
                    apply_to.push(value);
                }
            }
            item.apply_to = apply_to;
            Some(item)
        })
        .collect()
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default().trim().to_owned()
}

/// Go `AuthConfigured`: a matching rule whose credentials are present.
pub fn auth_configured(auth: &[AuthConfig], request_url: &str, kind: &str) -> bool {
    let Some(item) = matching_auth_config(auth, request_url, kind) else {
        return false;
    };
    match item.auth_type.trim().go_lower().as_str() {
        AUTH_TYPE_BEARER | AUTH_TYPE_GITHUB_TOKEN => !env(&item.token_env).is_empty(),
        AUTH_TYPE_BASIC => !env(&item.username_env).is_empty() && !env(&item.password_env).is_empty(),
        AUTH_TYPE_HEADER => !item.header_name.is_empty() && !env(&item.header_value_env).is_empty(),
        _ => false,
    }
}

/// Go `PluginAuthConfigured`: a credential applies to the plugin's registry, its
/// artifacts, or its GitHub release metadata.
pub fn plugin_auth_configured(source: &Source, plugin: &Plugin, auth: &[AuthConfig]) -> bool {
    if auth_configured(auth, &source.url, REQUEST_KIND_REGISTRY) {
        return true;
    }
    match super::registry::plugin_install_type(plugin).as_str() {
        INSTALL_TYPE_DIRECT => super::registry::plugin_artifacts(plugin)
            .iter()
            .any(|a| auth_configured(auth, &a.url, REQUEST_KIND_ARTIFACT)),
        INSTALL_TYPE_GITHUB_RELEASE => {
            let Ok((owner, repo)) = github_repository_parts(&plugin.repository) else {
                return false;
            };
            let releases = format!(
                "https://api.github.com/repos/{}/{}/releases/",
                url::path_escape(&owner),
                url::path_escape(&repo)
            );
            auth_configured(auth, &format!("{releases}latest"), REQUEST_KIND_METADATA)
                || auth_configured(auth, &format!("{releases}tags/"), REQUEST_KIND_METADATA)
        }
        _ => false,
    }
}

/// Request headers in Go `http.Header` form (canonical keys).
pub type Headers = std::collections::BTreeMap<String, Vec<String>>;

fn set_header(headers: &mut Headers, name: &str, value: String) {
    headers.insert(cpa_exec::proxy::canonical_header(name), vec![value]);
}

/// Go `applyPluginStoreAuthForClient`: a matching rule; whether credentials were
/// added.
pub(super) fn apply_auth(
    headers: &mut Headers,
    auth: &[AuthConfig],
    request_url: &str,
    kind: &str,
) -> Result<bool, String> {
    let Some(item) = matching_auth_config(auth, request_url, kind) else {
        return Ok(false);
    };
    match item.auth_type.trim().go_lower().as_str() {
        "" | AUTH_TYPE_NONE => return Ok(false),
        AUTH_TYPE_BEARER | AUTH_TYPE_GITHUB_TOKEN => {
            let token = env_value_required(&item.token_env, "token-env")?;
            set_header(headers, "Authorization", format!("Bearer {token}"));
        }
        AUTH_TYPE_BASIC => {
            let username = env_value_required(&item.username_env, "username-env")?;
            let password = env_value_required(&item.password_env, "password-env")?;
            use base64::Engine as _;
            let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
            set_header(headers, "Authorization", format!("Basic {encoded}"));
        }
        AUTH_TYPE_HEADER => {
            if item.header_name.trim().is_empty() {
                return Err("plugin store auth missing header-name".into());
            }
            let value = env_value_required(&item.header_value_env, "header-value-env")?;
            set_header(headers, &item.header_name, value);
        }
        _ => {
            return Err(format!(
                "unsupported plugin store auth type {}",
                cpa_common::gostr::quote(&item.auth_type)
            ));
        }
    }
    Ok(true)
}

/// Go `validatePluginStoreRequestURL`.
pub(super) fn validate_request_url(auth: &[AuthConfig], request_url: &str, kind: &str) -> Result<(), String> {
    let parsed = match url::parse(request_url.trim()) {
        Some(u) if !u.scheme.is_empty() && !u.host.is_empty() => u,
        _ => return Err("invalid plugin store url".into()),
    };
    if parsed.has_user {
        return Err("plugin store url must not contain credentials".into());
    }
    if url::has_sensitive_query_parameter(&parsed) {
        return Err("plugin store url contains sensitive query parameter".into());
    }
    if parsed.scheme.eq_ignore_ascii_case("http")
        && !matching_auth_config(auth, request_url, kind).is_some_and(|item| item.allow_insecure)
    {
        return Err("insecure plugin store url requires matching allow-insecure auth rule".into());
    }
    Ok(())
}

/// Go `matchingAuthConfig`: the first normalised rule matching the URL and kind.
pub(super) fn matching_auth_config(auth: &[AuthConfig], request_url: &str, kind: &str) -> Option<AuthConfig> {
    let kind = kind.trim().go_lower();
    normalize_auth_configs(auth)
        .into_iter()
        .find(|item| url_matches_rule(request_url.trim(), &item.matches) && applies_to(&item.apply_to, &kind))
}

fn applies_to(apply_to: &[String], kind: &str) -> bool {
    apply_to.is_empty() || apply_to.iter().any(|v| v.trim().eq_ignore_ascii_case(kind))
}

/// Go `pluginStoreURLMatchesAuthRule`: same scheme and host (any case), and the
/// rule's path as a segment prefix.
fn url_matches_rule(request_url: &str, match_url: &str) -> bool {
    let (Some(request), Some(rule)) = (url::parse(request_url.trim()), url::parse(match_url.trim())) else {
        return false;
    };
    if request.scheme.is_empty() || request.host.is_empty() || rule.scheme.is_empty() || rule.host.is_empty() {
        return false;
    }
    if !request.scheme.eq_ignore_ascii_case(&rule.scheme) || !request.host.eq_ignore_ascii_case(&rule.host) {
        return false;
    }
    path_matches_rule(&url::path(&request), &url::path(&rule))
}

fn path_matches_rule(request_path: &str, rule_path: &str) -> bool {
    if rule_path.is_empty() || rule_path == "/" {
        return true;
    }
    let request_path = if request_path.is_empty() { "/" } else { request_path };
    if request_path == rule_path {
        return true;
    }
    if rule_path.ends_with('/') {
        return request_path.starts_with(rule_path);
    }
    request_path.starts_with(&format!("{rule_path}/"))
}

/// Go `envValueRequired`.
fn env_value_required(name: &str, field: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(format!("plugin store auth missing {field}"));
    }
    let value = env(name);
    if value.is_empty() {
        return Err(format!("plugin store auth env {name} is empty"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_paths_match_by_segment() {
        assert!(url_matches_rule("https://H.example/a/b", "https://h.example/a"));
        assert!(!url_matches_rule("https://h.example/ab", "https://h.example/a"));
        assert!(!url_matches_rule("https://h.example/ab", "https://h.example/a/"));
        assert!(url_matches_rule("https://h.example/a/b", "https://h.example/a/"));
        assert!(!url_matches_rule("https://h.example/a", "http://h.example/a"));
        assert!(url_matches_rule("https://h.example", "https://h.example/"));
    }
}
