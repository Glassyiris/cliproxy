//! Config import migration and mapping edits, separate from the runtime snapshot.
use anyhow::{Context, bail};
use serde_yaml_ng::{Mapping, Value};

use super::{lookup, validate_shape};

// internal/config/config_v8.go buildV8Paths. Move individual mapping leaves, not
// entire legacy structs: v8 siblings must not suppress unrelated legacy siblings.
const PATHS: &[(&str, &str)] = &[
    ("host", "server.host"),
    ("port", "server.port"),
    ("max-request-body-bytes", "server.max-request-body-bytes"),
    ("trusted-proxies", "server.trusted-proxies"),
    ("github-token", "server.github-token"),
    ("tls", "server.tls"),
    ("commercial-mode", "server.commercial-mode"),
    ("discovery", "server.discovery"),
    ("remote-management", "management"),
    ("force-model-prefix", "routing.force-model-prefix"),
    ("request-retry", "routing.retry.request-retry"),
    ("max-retry-credentials", "routing.retry.max-retry-credentials"),
    ("max-retry-interval", "routing.retry.max-retry-interval"),
    ("disable-cooling", "routing.cooldown.disable-cooling"),
    ("save-cooldown-status", "routing.cooldown.save-cooldown-status"),
    (
        "transient-error-cooldown-seconds",
        "routing.cooldown.transient-error-cooldown-seconds",
    ),
    ("proxy-url", "requests.proxy-url"),
    (
        "tls-handshake-timeout-seconds",
        "requests.tls-handshake-timeout-seconds",
    ),
    ("passthrough-headers", "requests.passthrough-headers"),
    ("nonstream-keepalive-interval", "requests.nonstream-keepalive-interval"),
    ("streaming", "requests.streaming"),
    ("payload", "requests.payload"),
    ("auth-dir", "oauth.auth-dir"),
    ("auth-auto-refresh-workers", "oauth.auth-auto-refresh-workers"),
    ("oauth-model-alias", "oauth.model-alias"),
    ("oauth-excluded-models", "oauth.excluded-models"),
    ("oauth-request-scoped-errors", "oauth.request-scoped-errors"),
    ("oauth-settings", "oauth.settings"),
    ("ws-auth", "oauth.providers.aistudio.ws-auth"),
    ("codex.disable-codex-cloaking", "upstream.codex.disable-codex-cloaking"),
    (
        "codex.stream-bootstrap-buffering",
        "upstream.codex.stream-bootstrap-buffering",
    ),
    (
        "codex.stream-bootstrap-timeout",
        "upstream.codex.stream-bootstrap-timeout",
    ),
    (
        "codex.orphan-delegation-compatibility",
        "upstream.codex.orphan-delegation-compatibility",
    ),
    ("codex.model-level-cooling", "upstream.codex.model-level-cooling"),
    ("codex.response-steering", "upstream.codex.response-steering"),
    ("codex", "oauth.providers.codex"),
    ("codex-header-defaults", "oauth.providers.codex.header-defaults"),
    // Go walks the declared fields of ClaudeConfig and ClaudeCode.
    ("claude.model-level-cooling", "upstream.claude.model-level-cooling"),
    ("claude.tool-search", "upstream.claude.tool-search"),
    ("claude.session-date-pin-days", "upstream.claude.session-date-pin-days"),
    (
        "claude-code.disable-cloaking-model-list",
        "upstream.claude.disable-cloaking-model-list",
    ),
    ("disable-claude-cloak-mode", "upstream.claude.disable-claude-cloak-mode"),
    ("claude-header-defaults", "upstream.claude.header-defaults"),
    ("antigravity", "oauth.providers.antigravity"),
    (
        "antigravity-signature-cache-enabled",
        "oauth.providers.antigravity.signature-cache-enabled",
    ),
    (
        "antigravity-signature-bypass-strict",
        "oauth.providers.antigravity.signature-bypass-strict",
    ),
    (
        "quota-exceeded.antigravity-credits",
        "oauth.providers.antigravity.antigravity-credits",
    ),
    ("xai", "upstream.xai"),
    ("devin", "oauth.providers.devin"),
    ("disable-image-generation", "multimedia.disable-image-generation"),
    ("gpt-image-2-base-model", "multimedia.gpt-image-2-base-model"),
    ("video-result-auth-cache-ttl", "multimedia.video-result-auth-cache-ttl"),
    ("debug", "observability.logs.debug"),
    ("logging-to-file", "observability.logs.logging-to-file"),
    ("logs-max-total-size-mb", "observability.logs.logs-max-total-size-mb"),
    ("request-log", "observability.logs.request-log"),
    ("error-logs-max-files", "observability.logs.error-logs-max-files"),
    (
        "usage-statistics-enabled",
        "observability.usage.usage-statistics-enabled",
    ),
    (
        "redis-usage-queue-retention-seconds",
        "observability.usage.redis-usage-queue-retention-seconds",
    ),
    ("pprof", "observability.pprof"),
];
// Go `v8ClientPaths`: the first historical spelling present wins.
const CLIENT_PATHS: &[(&str, &str)] = &[
    (
        "oauth.providers.codex.optimize-multi-agent-v2",
        "client.codex.optimize-multi-agent-v2",
    ),
    (
        "providers.codex.optimize-multi-agent-v2",
        "client.codex.optimize-multi-agent-v2",
    ),
    ("codex.optimize-multi-agent-v2", "client.codex.optimize-multi-agent-v2"),
];
// Go `v8SharedPaths` (52d5507d): historical v8 spellings of the shared `upstream`
// settings. A canonical path wins by presence; these precede the legacy roots.
pub(super) const SHARED_PATHS: &[(&str, &str)] = &[
    (
        "oauth.providers.codex.disable-codex-cloaking",
        "upstream.codex.disable-codex-cloaking",
    ),
    (
        "oauth.providers.codex.stream-bootstrap-buffering",
        "upstream.codex.stream-bootstrap-buffering",
    ),
    (
        "oauth.providers.codex.stream-bootstrap-timeout",
        "upstream.codex.stream-bootstrap-timeout",
    ),
    (
        "oauth.providers.codex.orphan-delegation-compatibility",
        "upstream.codex.orphan-delegation-compatibility",
    ),
    (
        "oauth.providers.codex.model-level-cooling",
        "upstream.codex.model-level-cooling",
    ),
    (
        "oauth.providers.codex.response-steering",
        "upstream.codex.response-steering",
    ),
    (
        "oauth.providers.claude.model-level-cooling",
        "upstream.claude.model-level-cooling",
    ),
    (
        "oauth.providers.claude.claude-code.disable-cloaking-model-list",
        "upstream.claude.disable-cloaking-model-list",
    ),
    (
        "oauth.providers.claude.disable-claude-cloak-mode",
        "upstream.claude.disable-claude-cloak-mode",
    ),
    (
        "oauth.providers.claude.header-defaults.user-agent",
        "upstream.claude.header-defaults.user-agent",
    ),
    (
        "oauth.providers.claude.header-defaults.package-version",
        "upstream.claude.header-defaults.package-version",
    ),
    (
        "oauth.providers.claude.header-defaults.runtime-version",
        "upstream.claude.header-defaults.runtime-version",
    ),
    (
        "oauth.providers.claude.header-defaults.os",
        "upstream.claude.header-defaults.os",
    ),
    (
        "oauth.providers.claude.header-defaults.arch",
        "upstream.claude.header-defaults.arch",
    ),
    (
        "oauth.providers.claude.header-defaults.timeout",
        "upstream.claude.header-defaults.timeout",
    ),
    (
        "oauth.providers.claude.header-defaults.timezone",
        "upstream.claude.header-defaults.timezone",
    ),
    (
        "oauth.providers.claude.header-defaults.stabilize-device-profile",
        "upstream.claude.header-defaults.stabilize-device-profile",
    ),
    ("oauth.providers.xai.inject-x-search", "upstream.xai.inject-x-search"),
];
// Go `v8SharedStructPaths`: an empty or null historical container is an empty
// `upstream` one; populated ones move through their fields.
pub(super) const SHARED_STRUCTS: &[(&str, &str)] = &[
    (
        "oauth.providers.claude.header-defaults",
        "upstream.claude.header-defaults",
    ),
    ("oauth.providers.claude.claude-code", "upstream.claude"),
    ("oauth.providers.claude", "upstream.claude"),
    ("oauth.providers.xai", "upstream.xai"),
];
const FAMILIES: &[(&str, &str)] = &[
    ("gemini-api-key", "gemini"),
    ("interactions-api-key", "interactions"),
    ("vertex-api-key", "vertex"),
    ("codex-api-key", "codex"),
    ("claude-api-key", "claude"),
    ("xai-api-key", "xai"),
    ("meta-api-key", "meta"),
    ("openai-compatibility", "openai-compatibility"),
];
const SHARED: &[&str] = &[
    "priority",
    "prefix",
    "proxy-url",
    "models",
    "headers",
    "excluded-models",
    "disable-cooling",
    "request-retry",
    "request-scoped-errors",
];

/// The v8 path a legacy path (as [`super::binary`] walks it: a key, or `None` for a list
/// item, per step) moves to in [`ConfigDocument::from_mapping`]; a v8 path as it is.
pub(super) fn v8_path<'a>(keys: &[Option<&'a str>]) -> Vec<Option<&'a str>> {
    let mut out = Vec::with_capacity(keys.len() + 3);
    match keys {
        [Some(root), None, rest @ ..] if let Some((_, family)) = FAMILIES.iter().find(|(old, _)| old == root) => {
            out.extend([Some("api-keys"), Some(*family), None]);
            match rest.first() {
                Some(Some("api-key-entries")) if *family == "openai-compatibility" => {
                    out.push(Some("keys"));
                    out.extend(&rest[1..]);
                    return out;
                }
                Some(Some(field))
                    if *family != "openai-compatibility" && *field != "base-url" && !SHARED.contains(field) =>
                {
                    out.extend([Some("keys"), None]);
                }
                _ => {}
            }
            out.extend(rest);
        }
        [Some("api-keys"), None, ..] => {
            out.push(Some("access"));
            out.extend(keys);
        }
        _ => {
            /// The moves split into steps.
            static MOVES: std::sync::LazyLock<Vec<(Vec<&str>, Vec<&str>)>> = std::sync::LazyLock::new(|| {
                PATHS
                    .iter()
                    .chain(CLIENT_PATHS)
                    .chain(SHARED_PATHS)
                    .chain(SHARED_STRUCTS)
                    .map(|(old, current)| (old.split('.').collect(), current.split('.').collect()))
                    .collect()
            });
            // Most paths start at a root no move names.
            let moved = MOVES
                .iter()
                .filter(|(old, _)| keys.first() == Some(&Some(old[0])))
                .filter(|(old, _)| old.len() <= keys.len() && old.iter().zip(keys).all(|(o, k)| *k == Some(*o)))
                .max_by_key(|(old, _)| old.len());
            match moved {
                Some((old, current)) => {
                    out.extend(current.iter().map(|step| Some(*step)));
                    out.extend(&keys[old.len()..]);
                }
                None => out.extend(keys),
            }
        }
    }
    out
}

#[derive(Clone)]
pub struct ConfigDocument(Value);

impl ConfigDocument {
    #[cfg(test)]
    pub(super) fn parse(text: &str) -> anyhow::Result<Self> {
        let mut root = super::config_value(text)?;
        // Go migrates the alias-expanded tree (`expandConfigAliases`): an edit next to
        // an inherited setting must keep it rather than shadow the whole mapping.
        super::expand_merges(&mut root)?;
        let root = match root {
            Value::Mapping(root) => root,
            // Go accepts an empty file on load, but management rejects empty writes.
            Value::Null if text.trim().is_empty() => Mapping::new(),
            _ => bail!("config must be a mapping"),
        };
        Self::from_mapping(root)
    }

    pub(super) fn from_mapping(mut root: Mapping) -> anyhow::Result<Self> {
        validate_shape(&root)?;
        move_aliases(&mut root)?;
        if let Some(keys) = root.get("api-keys").filter(|v| !v.is_mapping()).cloned() {
            root.remove("api-keys");
            insert_missing(&mut root, "access.api-keys", keys)?;
        }
        // The legacy Claude structs move by their leaves (PATHS); an empty or null one is
        // an empty `upstream.claude`, and other children stay as unknown fields.
        for old in ["claude", "claude-code"] {
            match root.get(old) {
                Some(Value::Null) => {}
                Some(Value::Mapping(m)) if m.is_empty() => {}
                Some(Value::Mapping(_)) | None => continue,
                Some(_) => bail!("{old} must be a mapping"),
            }
            root.remove(old);
            insert_missing(&mut root, "upstream.claude", Value::Mapping(Mapping::new()))?;
        }
        for (old, current) in PATHS {
            if let Some(mut value) = lookup(&root, old).cloned() {
                if value.is_null() && super::schema::is_struct(current) {
                    value = Value::Mapping(Mapping::new());
                }
                remove(&mut root, old);
                insert_missing(&mut root, current, value)?;
            }
        }
        for (old, family) in FAMILIES {
            if let Some(value) = root.remove(*old) {
                let groups = legacy_groups(value, family)?;
                insert_missing(&mut root, &format!("api-keys.{family}"), groups)?;
            }
        }
        root.insert(Value::from("config-version"), Value::from(8));
        Ok(Self(Value::Mapping(root)))
    }

    /// A document kept in its existing layout for resource edits.
    pub fn unmigrated(value: Value) -> Self {
        Self(value)
    }

    pub fn value(&self) -> &Value {
        &self.0
    }
    /// yaml.v3's decoding of typed scalars (see [`super::coerce_typed_scalars`]).
    pub(super) fn coerce_typed_scalars(&mut self) {
        super::schema::coerce_typed_scalars(&mut self.0);
    }
    pub fn into_value(self) -> Value {
        self.0
    }
    pub fn get(&self, parts: &[&str]) -> Option<&Value> {
        let mut node = &self.0;
        for part in parts {
            node = node.as_mapping()?.get(*part)?;
        }
        Some(node)
    }

    /// Paths identify mapping keys, never sequence indexes. PATCH recursively merges
    /// mappings and replaces scalars/lists; null is a value, not a deletion.
    pub fn update(&mut self, parts: &[&str], value: Value, patch: bool) -> anyhow::Result<()> {
        let mut dst = &mut self.0;
        for part in parts {
            if part.is_empty() {
                bail!("invalid_path");
            }
            let map = dst.as_mapping_mut().context("invalid_path")?;
            dst = map
                .entry(Value::from(*part))
                .or_insert_with(|| Value::Mapping(Mapping::new()));
        }
        if patch {
            merge(dst, value);
        } else {
            *dst = value;
        }
        Ok(())
    }

    /// Go `deleteConfigV8Path`: removes the field, then any ancestor mapping that this
    /// removal left empty. Other explicit empty mappings stay.
    pub fn delete(&mut self, parts: &[&str]) -> bool {
        fn remove(node: &mut Value, parts: &[&str]) -> bool {
            let Some(map) = node.as_mapping_mut() else {
                return false;
            };
            let Some((first, rest)) = parts.split_first() else {
                return false;
            };
            if rest.is_empty() {
                return map.remove(*first).is_some();
            }
            let Some(child) = map.get_mut(*first) else {
                return false;
            };
            if !remove(child, rest) {
                return false;
            }
            if child.as_mapping().is_some_and(serde_yaml_ng::Mapping::is_empty) {
                map.remove(*first);
            }
            true
        }
        remove(&mut self.0, parts)
    }
}

/// Go's `buildV8Paths` output for v8.0.35, in its order: the declared legacy leaves
/// and structs, each with its v8 path. Regenerate with
/// `tests/reference/legacy_paths/main.go`.
#[derive(serde::Deserialize)]
struct LegacyPaths {
    leaves: Vec<(String, String)>,
}

static LEGACY: std::sync::LazyLock<LegacyPaths> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!("legacy_paths.json")).expect("legacy_paths.json is valid")
});

fn merge(dst: &mut Value, src: Value) {
    if let (Value::Mapping(a), Value::Mapping(b)) = (&mut *dst, &src) {
        for (key, value) in b {
            merge(a.entry(key.clone()).or_insert(Value::Null), value.clone());
        }
    } else {
        *dst = src;
    }
}

/// Go `NormalizeV8ConfigAliases`' moves: historical client and shared spellings go
/// to their canonical paths, where a present value wins; an empty or null historical
/// container becomes an empty canonical one.
fn move_aliases(root: &mut Mapping) -> anyhow::Result<()> {
    for (old, current) in CLIENT_PATHS.iter().chain(SHARED_PATHS) {
        if let Some(value) = lookup(root, old).cloned() {
            remove(root, old);
            insert_missing(root, current, value)?;
        }
    }
    for (old, current) in SHARED_STRUCTS {
        match lookup(root, old) {
            None => continue,
            Some(Value::Null) => {}
            Some(Value::Mapping(m)) if m.is_empty() => {}
            // Fields the schema does not know stay for validation to report.
            Some(Value::Mapping(_)) => continue,
            Some(_) => bail!("{old} must be a mapping"),
        }
        remove(root, old);
        insert_missing(root, current, Value::Mapping(Mapping::new()))?;
    }
    Ok(())
}

/// The layout checks of Go's `ValidateV8Config` that come before its strict decode, in
/// its order, with its text: a legacy field (Go's declared legacy leaves, the historical
/// v8 aliases, the shared structs), a root section v8 does not have, then an
/// `api-keys` provider that is not a key family. `root` is the merge-expanded document.
pub fn v8_layout_error(root: &Value) -> Option<String> {
    let map = root.as_mapping()?;
    let leaves = LEGACY.leaves.iter().map(|(old, new)| (old.as_str(), new.as_str()));
    let aliases = CLIENT_PATHS.iter().chain(SHARED_PATHS).chain(SHARED_STRUCTS).copied();
    for (old, new) in leaves.chain(aliases) {
        // Go `legacyPath`: an `api-keys` mapping is the v8 key map.
        if lookup(map, old).is_some_and(|v| !(old == "api-keys" && v.is_mapping())) {
            return Some(format!("legacy field {old} is not accepted by v8; use {new}"));
        }
    }
    // Go `v8AllowedRoots`.
    let fixed = [
        "models",
        "config-version",
        "api-keys",
        "plugins",
        "quota-exceeded",
        "client",
    ];
    for key in map.keys().filter_map(Value::as_str) {
        let section = |new: &String| new.split('.').next() == Some(key);
        if !fixed.contains(&key) && !LEGACY.leaves.iter().any(|(_, new)| section(new)) {
            return Some(format!("unknown v8 configuration section {key}"));
        }
    }
    let groups = map.get("api-keys").and_then(Value::as_mapping)?;
    groups
        .keys()
        .filter_map(Value::as_str)
        .find(|key| !FAMILIES.iter().any(|(_, family)| family == key))
        .map(|key| format!("unknown API-key provider {key}"))
}

/// Go `flattenV8`'s shape checks, in its order: every parent of a v8 path, then of a
/// historical alias's destination, must be a mapping (`routing` may also be null, as
/// in the legacy layout); then each shared container (`v8SharedStructPaths`) must be a
/// mapping or null. `root` is the merge-expanded document.
pub(super) fn shape_error(root: &Mapping) -> Option<String> {
    static PARENTS: std::sync::LazyLock<Vec<String>> = std::sync::LazyLock::new(|| {
        let aliases = CLIENT_PATHS.iter().chain(SHARED_PATHS).map(|(_, current)| *current);
        let mut out: Vec<String> = Vec::new();
        for current in LEGACY.leaves.iter().map(|(_, current)| current.as_str()).chain(aliases) {
            for (i, _) in current.match_indices('.') {
                if !out.iter().any(|p| *p == current[..i]) {
                    out.push(current[..i].to_owned());
                }
            }
        }
        out
    });
    for parent in PARENTS.iter() {
        match lookup(root, parent) {
            None | Some(Value::Mapping(_)) => {}
            Some(Value::Null) if parent == "routing" => {}
            Some(_) => return Some(format!("{parent} must be a mapping")),
        }
    }
    SHARED_STRUCTS.iter().find_map(|(old, _)| match lookup(root, old) {
        None | Some(Value::Null | Value::Mapping(_)) => None,
        Some(_) => Some(format!("{old} must be a mapping")),
    })
}

/// The credential checks Go's `validateCredentialWeightYAML` makes (first in
/// `LoadConfig` and `ParseConfigBytes`, unwrapped), after `flattenV8`'s shape and
/// version checks: [`v8_group_error`], then the weights of the legacy key lists and
/// OpenAI-compatible `api-key-entries` a v8 family does not replace, in document order.
/// `root` is the merge-expanded document.
pub fn credential_error(root: &Mapping) -> Option<String> {
    if let Some(e) = v8_group_error(root) {
        return Some(e);
    }
    let groups = root.get("api-keys").and_then(Value::as_mapping);
    root.iter().find_map(|(name, value)| {
        let name = name.as_str()?;
        let (_, family) = FAMILIES.iter().find(|(legacy, _)| *legacy == name)?;
        if groups.is_some_and(|g| g.contains_key(*family)) {
            return None;
        }
        if name != "openai-compatibility" {
            return weight_error(value.as_sequence()?, name);
        }
        value.as_sequence()?.iter().enumerate().find_map(|(p, provider)| {
            let entries = provider.as_mapping()?.get("api-key-entries")?.as_sequence()?;
            weight_error(entries, &format!("openai-compatibility[{p}].api-key-entries"))
        })
    })
}

/// Go `flattenV8`'s v8 key group expansion (`expandV8Groups`), in family order, the
/// group keys' weights included. `root` is the merge-expanded document.
pub fn v8_group_error(root: &Mapping) -> Option<String> {
    let groups = root.get("api-keys").and_then(Value::as_mapping)?;
    for (_, family) in FAMILIES {
        let Some(groups) = groups.get(*family) else {
            continue;
        };
        let Some(groups) = groups.as_sequence() else {
            return Some(format!("api-keys.{family} must be a list"));
        };
        for (index, group) in groups.iter().enumerate() {
            let Some(group) = group.as_mapping() else {
                return Some(format!("api-keys.{family}[{index}] must be a mapping"));
            };
            let Some(keys) = group.get("keys").and_then(Value::as_sequence) else {
                return Some(format!("api-keys.{family}[{index}].keys must be a list"));
            };
            if let Some(e) = weight_error(keys, &format!("api-keys.{family}.keys")) {
                return Some(e);
            }
            if *family == "openai-compatibility" {
                continue;
            }
            let unsupported = group
                .keys()
                .map(|k| k.as_str().unwrap_or_default())
                .find(|field| !["name", "base-url", "keys"].contains(field) && !SHARED.contains(field));
            if let Some(field) = unsupported {
                return Some(format!("api-keys.{family}: unsupported group field {field}"));
            }
            for key in keys {
                let Some(key) = key.as_mapping() else {
                    return Some(format!("api-keys.{family} key must be a mapping"));
                };
                if key.contains_key("base-url") {
                    return Some(format!("api-keys.{family}: base-url belongs to the group"));
                }
            }
        }
    }
    None
}

/// Go `validateWeightSequenceNode`: the first weight that is not an integer node or is
/// above the limit, as `<path>[<i>].weight: <reason>`.
fn weight_error(items: &[Value], path: &str) -> Option<String> {
    items.iter().enumerate().find_map(|(i, item)| {
        let weight = item.as_mapping()?.get("weight")?;
        let reason = match weight.as_i64() {
            None => "weight must be an integer",
            Some(w) if w > 1_000_000 => "weight must not exceed 1000000",
            Some(_) => return None,
        };
        Some(format!("{path}[{i}].weight: {reason}"))
    })
}

fn insert_missing(root: &mut Mapping, path: &str, value: Value) -> anyhow::Result<()> {
    let parts: Vec<_> = path.split('.').collect();
    let mut map = root;
    for part in &parts[..parts.len() - 1] {
        if *part == "routing" && map.get(*part).is_some_and(Value::is_null) {
            map.insert(Value::from(*part), Value::Mapping(Mapping::new()));
        }
        map = map
            .entry(Value::from(*part))
            .or_insert_with(|| Value::Mapping(Mapping::new()))
            .as_mapping_mut()
            .context("config parent must be a mapping")?;
    }
    let key = Value::from(parts[parts.len() - 1]);
    if let Some(existing) = map.get_mut(&key) {
        if let (Value::Mapping(dst), Value::Mapping(src)) = (existing, value) {
            for (key, value) in src {
                insert_missing(dst, key.as_str().context("config keys must be strings")?, value)?;
            }
        }
    } else {
        map.insert(key, value);
    }
    Ok(())
}

fn remove(root: &mut Mapping, path: &str) {
    let Some((head, rest)) = path.split_once('.') else {
        root.remove(path);
        return;
    };
    if let Some(Value::Mapping(child)) = root.get_mut(head) {
        remove(child, rest);
        if child.is_empty() {
            root.remove(head);
        }
    }
}

fn legacy_groups(value: Value, family: &str) -> anyhow::Result<Value> {
    if value.is_null() {
        return Ok(Value::Sequence(Vec::new()));
    }
    let entries = value.as_sequence().context("legacy provider keys must be a list")?;
    let mut groups = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        let mut key = entry.as_mapping().context("provider key must be a mapping")?.clone();
        if family == "openai-compatibility" {
            let keys = key.remove("api-key-entries").unwrap_or(Value::Sequence(Vec::new()));
            key.insert(Value::from("keys"), keys);
            groups.push(Value::Mapping(key));
            continue;
        }
        let mut group = Mapping::new();
        group.insert(Value::from("name"), Value::from(format!("{family}-{}", i + 1)));
        for name in std::iter::once(&"base-url").chain(SHARED) {
            if let Some(value) = key.remove(*name) {
                group.insert(Value::from(*name), value);
            }
        }
        group.insert(Value::from("keys"), Value::Sequence(vec![Value::Mapping(key)]));
        groups.push(Value::Mapping(group));
    }
    Ok(Value::Sequence(groups))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_layout_merges_leaves_and_keeps_presence() {
        let d = ConfigDocument::parse("request-retry: 4\ndisable-cooling: true\nrouting: {retry: {request-retry: null}, cooldown: {disable-cooling: false}}\ncodex: {disable-codex-cloaking: true, response-steering: false, optimize-multi-agent-v2: true}\nclient: {codex: {optimize-multi-agent-v2: false}}\noauth: {providers: {codex: {response-steering: true}, xai: {}}}\n").unwrap();
        assert!(d.get(&["routing", "retry", "request-retry"]).unwrap().is_null());
        assert_eq!(
            d.get(&["routing", "cooldown", "disable-cooling"]),
            Some(&Value::Bool(false))
        );
        // v8.0.35: shared settings move to `upstream`; a historical v8 spelling wins
        // over the legacy root one.
        assert_eq!(
            d.get(&["upstream", "codex", "disable-codex-cloaking"]),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            d.get(&["upstream", "codex", "response-steering"]),
            Some(&Value::Bool(true))
        );
        assert_eq!(d.get(&["upstream", "xai"]), Some(&Value::Mapping(Mapping::new())));
        assert!(d.get(&["oauth", "providers"]).is_none(), "{:?}", d.value());
        assert_eq!(
            d.get(&["client", "codex", "optimize-multi-agent-v2"]),
            Some(&Value::Bool(false))
        );
        assert!(d.get(&["request-retry"]).is_none());
    }

    #[test]
    fn paths_are_mapping_keys_and_patch_null_is_not_deletion() {
        let mut d = ConfigDocument::parse("access: {api-keys: [old]}\n").unwrap();
        assert!(d.update(&["access", "api-keys", "0"], Value::from("x"), false).is_err());
        d.update(&["access"], serde_yaml_ng::from_str("{api-keys: null}").unwrap(), true)
            .unwrap();
        assert!(d.get(&["access", "api-keys"]).unwrap().is_null());
        assert!(d.delete(&["access", "api-keys"]));
        assert!(!d.delete(&["access", "api-keys"]));
    }

    #[test]
    fn legacy_entries_are_not_coalesced() {
        let d = ConfigDocument::parse("claude-api-key: [{api-key: fake1, base-url: http://example.invalid, weight: 0}, {api-key: fake2, base-url: http://example.invalid}]\n").unwrap();
        let groups = d.get(&["api-keys", "claude"]).unwrap().as_sequence().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["keys"][0]["weight"].as_i64(), Some(0));
        assert_eq!(groups[0]["keys"][0]["api-key"].as_str(), Some("fake1"));
    }
}
