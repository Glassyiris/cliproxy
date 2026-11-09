//! The resource model of the config store, without SQL: how stored resources compile
//! into the config document the runtime reads, and how a document splits back into
//! resources. Everything here works on the JSON form of the document.

use std::collections::{BTreeMap, HashSet};

use cpa_core::config::Config;
use serde::Serialize;
use serde_json::{Map, Value as Json};

/// The kinds of resource. A setting is one top-level section of the document; the
/// others are the entries of a list or map the document holds them in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Setting,
    /// One entry of `api-keys.<type>`, with the family in `spec.type`.
    Provider,
    /// One entry of `access.api-keys`, as `{"key": ...}`.
    ClientKey,
    /// One entry of `model-routers`.
    Router,
    /// One entry of `plugins.configs`, keyed by its id.
    Plugin,
}

impl Kind {
    pub const ALL: [Kind; 5] = [
        Kind::Setting,
        Kind::Provider,
        Kind::ClientKey,
        Kind::Router,
        Kind::Plugin,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Kind::Setting => "setting",
            Kind::Provider => "provider",
            Kind::ClientKey => "client-key",
            Kind::Router => "router",
            Kind::Plugin => "plugin",
        }
    }

    pub fn parse(name: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| k.name() == name)
    }

    /// Whether `ord` places the resource: list entries are ordered, sections and map
    /// entries are not.
    pub fn ordered(self) -> bool {
        matches!(self, Kind::Provider | Kind::ClientKey | Kind::Router)
    }
}

/// The provider families under `api-keys`, in the order the document lists them.
pub const FAMILIES: [&str; 8] = [
    "claude",
    "codex",
    "gemini",
    "interactions",
    "meta",
    "openai-compatibility",
    "vertex",
    "xai",
];

/// Top-level keys that are not settings: the split-out lists and the version.
const NOT_SETTINGS: [&str; 3] = ["api-keys", "model-routers", "config-version"];

/// What replaces a secret in history, exports and the redacted reads. A write that
/// sends it back at the same place keeps the stored value.
pub const SECRET: &str = "$secret";

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Resource {
    pub kind: Kind,
    pub id: String,
    pub ord: i64,
    pub spec: Json,
    pub description: String,
    /// The revision that last wrote it; 0 before it is stored.
    pub rev: u64,
    pub created_rev: u64,
}

impl Resource {
    pub fn new(kind: Kind, id: impl Into<String>, ord: i64, spec: Json) -> Self {
        Self {
            kind,
            id: id.into(),
            ord,
            spec,
            description: String::new(),
            rev: 0,
            created_rev: 0,
        }
    }

    /// `kind/id`, as errors and the API name a resource.
    pub fn key(&self) -> String {
        format!("{}/{}", self.kind.name(), self.id)
    }

    /// The list a resource is ordered in, within its kind: a provider's family.
    pub fn group(&self) -> &str {
        match self.kind {
            Kind::Provider => self.spec.get("type").and_then(Json::as_str).unwrap_or_default(),
            _ => "",
        }
    }

    /// Same stored content, whatever revision wrote it.
    pub fn same_content(&self, other: &Resource) -> bool {
        self.spec == other.spec && self.ord == other.ord && self.description == other.description
    }
}

/// A failure tied, when it can be, to the resource that caused it.
#[derive(Debug, Clone, PartialEq)]
pub struct Fault {
    pub resource: Option<String>,
    pub message: String,
}

impl Fault {
    pub fn new(resource: Option<String>, message: impl Into<String>) -> Self {
        Self {
            resource,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.resource {
            Some(r) => write!(f, "{r}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

/// An id is a URL path segment: 1 to 128 bytes, no `/`, no control characters, and
/// not `.` or `..`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.chars().any(char::is_control)
}

/// Checks what the document cannot check about a resource: its id and the shape of
/// its spec.
pub fn check(r: &Resource) -> Result<(), Fault> {
    let fault = |m: &str| Err(Fault::new(Some(r.key()), m));
    if !valid_id(&r.id) {
        return fault("invalid id: 1 to 128 bytes, without '/' or control characters");
    }
    match r.kind {
        Kind::Setting if NOT_SETTINGS.contains(&r.id.as_str()) => {
            fault("this section is stored as provider, router or plugin resources")
        }
        Kind::Setting if r.id == "access" && r.spec.get("api-keys").is_some() => {
            fault("client keys are client-key resources, not part of setting/access")
        }
        Kind::Setting if r.id == "plugins" && r.spec.get("configs").is_some() => {
            fault("plugin configs are plugin resources, not part of setting/plugins")
        }
        Kind::Provider => match r.spec.get("type").and_then(Json::as_str) {
            _ if !r.spec.is_object() => fault("spec must be an object"),
            Some(t) if FAMILIES.contains(&t) => Ok(()),
            _ => fault(&format!("spec.type must be one of {}", FAMILIES.join(", "))),
        },
        Kind::ClientKey => match r.spec.get("key") {
            Some(Json::String(k)) if !k.trim().is_empty() && r.spec.as_object().is_some_and(|m| m.len() == 1) => Ok(()),
            _ => fault("spec must be {\"key\": \"<non-empty key>\"}"),
        },
        Kind::Router | Kind::Plugin if !r.spec.is_object() => fault("spec must be an object"),
        _ => Ok(()),
    }
}

/// The document `resources` compile to. With `annotate`, every provider and router
/// entry carries `"@id"`, which [`split`] reads to keep its identity; the runtime
/// never sees it.
pub fn document(resources: &[Resource], annotate: bool) -> Json {
    let mut root = Map::new();
    root.insert("config-version".into(), 8.into());
    let mut sorted: Vec<&Resource> = resources.iter().collect();
    sorted.sort_by(|a, b| (a.kind, a.ord, &a.id).cmp(&(b.kind, b.ord, &b.id)));
    let entry = |r: &Resource, drop: Option<&str>| {
        let mut spec = r.spec.clone();
        if let Some(map) = spec.as_object_mut() {
            if let Some(field) = drop {
                map.remove(field);
            }
            if annotate {
                map.insert("@id".into(), r.id.clone().into());
            }
        }
        spec
    };
    let mut families: BTreeMap<usize, Vec<Json>> = BTreeMap::new();
    let mut keys = Vec::new();
    let mut routers = Vec::new();
    let mut plugins = Map::new();
    for r in sorted {
        match r.kind {
            Kind::Setting => {
                root.insert(r.id.clone(), r.spec.clone());
            }
            Kind::Provider => {
                let family = r.spec.get("type").and_then(Json::as_str).unwrap_or_default();
                let slot = FAMILIES.iter().position(|f| *f == family).unwrap_or(FAMILIES.len());
                families.entry(slot).or_default().push(entry(r, Some("type")));
            }
            Kind::ClientKey => keys.push(r.spec.get("key").cloned().unwrap_or(Json::Null)),
            Kind::Router => routers.push(entry(r, None)),
            Kind::Plugin => {
                plugins.insert(r.id.clone(), r.spec.clone());
            }
        }
    }
    if !families.is_empty() {
        let map = families
            .into_iter()
            .map(|(slot, list)| {
                (
                    FAMILIES.get(slot).copied().unwrap_or("unknown").to_owned(),
                    Json::Array(list),
                )
            })
            .collect();
        root.insert("api-keys".into(), Json::Object(map));
    }
    let mut child = |section: &str, field: &str, value: Json| {
        let parent = root.entry(section).or_insert_with(|| Json::Object(Map::new()));
        // A setting that is not a mapping fails validation; keep it so it does.
        if let Some(map) = parent.as_object_mut() {
            map.insert(field.into(), value);
        }
    };
    if !keys.is_empty() {
        child("access", "api-keys", Json::Array(keys));
    }
    if !plugins.is_empty() {
        child("plugins", "configs", Json::Object(plugins));
    }
    if !routers.is_empty() {
        root.insert("model-routers".into(), Json::Array(routers));
    }
    Json::Object(root)
}

/// The runtime config `resources` compile to and the YAML text it was parsed from,
/// validated as strictly as a write: unknown fields are refused.
pub fn config(resources: &[Resource]) -> Result<(Config, String), Fault> {
    for r in resources {
        check(r)?;
    }
    let doc = document(resources, false);
    let yaml: serde_yaml_ng::Value =
        serde_yaml_ng::to_value(&doc).map_err(|e| Fault::new(None, format!("config is not YAML: {e}")))?;
    cpa_core::config::validate_config_fields(&yaml, true).map_err(|e| Fault::new(None, format!("{e:#}")))?;
    let text = cpa_core::config::yaml_string(&yaml).map_err(|e| Fault::new(None, e.to_string()))?;
    let cfg = Config::parse_payload(&text).map_err(|e| Fault::new(None, format!("{e:#}")))?;
    Ok((cfg, text))
}

/// `doc` as resources. Entries keep the id of the resource in `old` they came from:
/// providers and routers by `"@id"`, then routers by name, client keys by value,
/// plugins and settings by key. Others get an id from their `name`, else a numbered
/// one. Descriptions and creation revisions carry over from `old`.
pub fn split(doc: &Json, old: &[Resource]) -> Result<Vec<Resource>, Fault> {
    let root = doc
        .as_object()
        .ok_or_else(|| Fault::new(None, "config must be a mapping"))?;
    let mut out: Vec<Resource> = Vec::new();
    let mut taken: HashSet<(Kind, String)> = HashSet::new();
    // An id for a new entry: the one asked for when free, else its name, else `base-N`.
    let mut assign = |kind: Kind, asked: Option<&str>, name: Option<&str>, base: &str| -> String {
        let free = |id: &str, taken: &HashSet<(Kind, String)>| valid_id(id) && !taken.contains(&(kind, id.to_owned()));
        let id = asked
            .filter(|id| free(id, &taken))
            .or_else(|| name.map(str::trim).filter(|n| free(n, &taken)))
            .map(str::to_owned)
            .unwrap_or_else(|| {
                (1..)
                    .map(|n| format!("{base}-{n}"))
                    .find(|id| free(id, &taken))
                    .expect("unbounded")
            });
        taken.insert((kind, id.clone()));
        id
    };
    // Providers are ordered within their family, since that is the list they compile to.
    let mut ord = BTreeMap::<(Kind, String), i64>::new();
    let mut push = |kind: Kind, id: String, spec: Json, out: &mut Vec<Resource>| {
        let r = Resource::new(kind, id, 0, spec);
        let n = ord.entry((kind, r.group().to_owned())).or_default();
        let at = if kind.ordered() { *n } else { 0 };
        *n += 1;
        out.push(Resource { ord: at, ..r });
    };
    let entry_object = |value: &Json, at: &str| -> Result<Map<String, Json>, Fault> {
        value
            .as_object()
            .cloned()
            .ok_or_else(|| Fault::new(None, format!("{at} must be a mapping")))
    };
    let old_id = |kind: Kind, id: &str| old.iter().any(|r| r.kind == kind && r.id == id);
    for (key, value) in root {
        match key.as_str() {
            "config-version" => {}
            "api-keys" => {
                let Some(families) = value.as_object() else {
                    if value.is_null() {
                        continue;
                    }
                    return Err(Fault::new(None, "api-keys must be a mapping of provider types"));
                };
                for (family, list) in families {
                    for (i, item) in list.as_array().into_iter().flatten().enumerate() {
                        let mut spec = entry_object(item, &format!("api-keys.{family}[{i}]"))?;
                        let asked = spec.remove("@id").and_then(|v| v.as_str().map(str::to_owned));
                        let asked = asked.filter(|id| old_id(Kind::Provider, id) || valid_id(id));
                        let name = spec.get("name").and_then(Json::as_str).map(str::to_owned);
                        let id = assign(Kind::Provider, asked.as_deref(), name.as_deref(), family);
                        spec.insert("type".into(), family.clone().into());
                        push(Kind::Provider, id, Json::Object(spec), &mut out);
                    }
                    if !list.is_array() && !list.is_null() {
                        return Err(Fault::new(None, format!("api-keys.{family} must be a list")));
                    }
                }
            }
            "model-routers" => {
                for (i, item) in value.as_array().into_iter().flatten().enumerate() {
                    let mut spec = entry_object(item, &format!("model-routers[{i}]"))?;
                    let asked = spec.remove("@id").and_then(|v| v.as_str().map(str::to_owned));
                    let name = spec.get("name").and_then(Json::as_str).map(str::to_owned);
                    let id = assign(Kind::Router, asked.as_deref(), name.as_deref(), "router");
                    push(Kind::Router, id, Json::Object(spec), &mut out);
                }
            }
            "access" | "plugins" if value.is_object() => {
                let mut rest = value.as_object().cloned().unwrap_or_default();
                if key == "access" {
                    let keys = rest.remove("api-keys").unwrap_or(Json::Null);
                    for (i, k) in keys.as_array().into_iter().flatten().enumerate() {
                        let Some(text) = k.as_str() else {
                            return Err(Fault::new(None, format!("access.api-keys[{i}] must be a string")));
                        };
                        let known = old.iter().find(|r| {
                            r.kind == Kind::ClientKey && r.spec.get("key").and_then(Json::as_str) == Some(text)
                        });
                        let id = assign(Kind::ClientKey, known.map(|r| r.id.as_str()), None, "key");
                        push(Kind::ClientKey, id, serde_json::json!({ "key": text }), &mut out);
                    }
                } else {
                    let configs = rest.remove("configs").unwrap_or(Json::Null);
                    for (name, node) in configs.as_object().into_iter().flatten() {
                        if !valid_id(name) {
                            return Err(Fault::new(None, format!("plugins.configs: invalid plugin id {name:?}")));
                        }
                        push(Kind::Plugin, name.clone(), node.clone(), &mut out);
                    }
                }
                if !rest.is_empty() {
                    push(Kind::Setting, key.clone(), Json::Object(rest), &mut out);
                }
            }
            _ => push(Kind::Setting, key.clone(), value.clone(), &mut out),
        }
    }
    for r in &mut out {
        if let Some(before) = old.iter().find(|o| o.kind == r.kind && o.id == r.id) {
            r.description.clone_from(&before.description);
            r.created_rev = before.created_rev;
            r.rev = before.rev;
        }
    }
    out.sort_by(|a, b| (a.kind, a.ord, &a.id).cmp(&(b.kind, b.ord, &b.id)));
    Ok(out)
}

/// The JSON pointers, with `*` for any array index, that hold secrets in a resource.
fn secret_pointers(kind: Kind, id: &str) -> &'static [&'static str] {
    match (kind, id) {
        (Kind::Provider, _) => &["/keys/*/api-key"],
        (Kind::ClientKey, _) => &["/key"],
        (Kind::Setting, "management") => &["/secret-key"],
        (Kind::Setting, "oauth") => &[
            "/providers/codex/live-media-relay/ice-servers/*/credential",
            "/providers/codex/live-media-relay/ice-servers/*/username",
        ],
        (Kind::Setting, "artificial-analysis") => &["/api-key"],
        (Kind::Setting, "server") => &["/github-token"],
        _ => &[],
    }
}

/// The secrets every read hides as well: the management key's hash and the TURN
/// passwords. Other secrets are hidden only in history and exports, since the
/// dashboard shows provider and client keys and matches usage by them.
fn hidden_on_read(kind: Kind, id: &str) -> &'static [&'static str] {
    match (kind, id) {
        (Kind::Setting, "management" | "oauth") => secret_pointers(kind, id),
        _ => &[],
    }
}

/// Calls `f` with every value at `pattern` (segments, `*` for any array index), and
/// the concrete pointer it sits at.
fn each_at(value: &mut Json, pattern: &[&str], at: &mut String, f: &mut dyn FnMut(&str, &mut Json)) {
    let Some((first, rest)) = pattern.split_first() else {
        f(at, value);
        return;
    };
    let len = at.len();
    match (first, value) {
        (&"*", Json::Array(items)) => {
            for (i, item) in items.iter_mut().enumerate() {
                at.push_str(&format!("/{i}"));
                each_at(item, rest, at, f);
                at.truncate(len);
            }
        }
        (key, Json::Object(map)) => {
            if let Some(child) = map.get_mut(*key) {
                at.push('/');
                at.push_str(key);
                each_at(child, rest, at, f);
                at.truncate(len);
            }
        }
        _ => {}
    }
}

fn each_secret(pointers: &[&str], spec: &mut Json, f: &mut dyn FnMut(&str, &mut Json)) {
    for pointer in pointers {
        let segments: Vec<&str> = pointer.split('/').skip(1).collect();
        each_at(spec, &segments, &mut String::new(), f);
    }
}

fn hide(value: &mut Json) {
    if value.as_str().is_some_and(|s| !s.is_empty()) {
        *value = SECRET.into();
    }
}

/// `r` with every secret replaced by [`SECRET`], for history and exports.
pub fn redacted(r: &Resource) -> Resource {
    let mut r = r.clone();
    each_secret(secret_pointers(r.kind, &r.id), &mut r.spec, &mut |_, v| hide(v));
    r
}

/// `r` as reads show it: only the management key and TURN passwords hidden.
pub fn for_read(r: &Resource) -> Resource {
    let mut r = r.clone();
    each_secret(hidden_on_read(r.kind, &r.id), &mut r.spec, &mut |_, v| hide(v));
    r
}

/// The annotated document with what reads hide replaced by [`SECRET`].
pub fn document_for_read(resources: &[Resource]) -> Json {
    let shown: Vec<Resource> = resources.iter().map(for_read).collect();
    document(&shown, true)
}

/// Replaces each [`SECRET`] at a secret pointer of `r` by the value `stored` holds at
/// the same place. Fails, naming the pointer, when `stored` has none there.
pub fn resolve_secrets(r: &mut Resource, stored: Option<&Resource>) -> Result<(), Fault> {
    let key = r.key();
    let mut missing = None;
    each_secret(secret_pointers(r.kind, &r.id), &mut r.spec, &mut |at, v| {
        if v.as_str() != Some(SECRET) {
            return;
        }
        match stored
            .and_then(|s| s.spec.pointer(at))
            .filter(|s| s.as_str() != Some(SECRET))
        {
            Some(kept) => *v = kept.clone(),
            None => missing = missing.take().or_else(|| Some(at.to_owned())),
        }
    });
    match missing {
        Some(at) => Err(Fault::new(
            Some(key),
            format!("{at}: \"{SECRET}\" keeps a stored secret, and none is stored there; send the value"),
        )),
        None => Ok(()),
    }
}

/// Hashes a plaintext management key with bcrypt, so the store never holds it.
pub fn hash_management_key(r: &mut Resource) -> Result<(), Fault> {
    if r.kind != Kind::Setting || r.id != "management" {
        return Ok(());
    }
    let Some(Json::String(key)) = r.spec.get_mut("secret-key") else {
        return Ok(());
    };
    if key.is_empty() || cpa_core::config::is_bcrypt(key) || key == SECRET {
        return Ok(());
    }
    // bcrypt refuses longer keys rather than truncating them.
    if key.len() > 72 {
        return Err(Fault::new(Some(r.key()), "/secret-key: longer than 72 bytes"));
    }
    *key =
        bcrypt::hash(key.as_bytes(), 10).map_err(|e| Fault::new(Some("setting/management".into()), e.to_string()))?;
    Ok(())
}

/// The value at the slash-separated `path` of a document: mapping keys, and array
/// indexes in lists.
pub fn at_path<'a>(doc: &'a Json, path: &[&str]) -> Option<&'a Json> {
    path.iter().try_fold(doc, |node, part| match node {
        Json::Object(map) => map.get(*part),
        Json::Array(items) => part.parse::<usize>().ok().and_then(|i| items.get(i)),
        _ => None,
    })
}

/// Sets (`Some`) or removes (`None`) the value at `path`, creating missing mappings.
/// An array index must exist, except one past the end, which appends.
pub fn set_path(doc: &mut Json, path: &[&str], value: Option<Json>) -> Result<(), String> {
    let Some((last, parents)) = path.split_last() else {
        return match value {
            Some(v) if v.is_object() => {
                *doc = v;
                Ok(())
            }
            _ => Err("the whole config must be a mapping".into()),
        };
    };
    let mut node = doc;
    for part in parents {
        node = match node {
            Json::Object(map) => map.entry(part.to_string()).or_insert_with(|| Json::Object(Map::new())),
            Json::Array(items) => part
                .parse::<usize>()
                .ok()
                .and_then(|i| items.get_mut(i))
                .ok_or_else(|| format!("no list entry {part}"))?,
            _ => return Err(format!("{part}: not a mapping or list")),
        };
    }
    match (node, value) {
        (Json::Object(map), Some(v)) => {
            map.insert(last.to_string(), v);
        }
        (Json::Object(map), None) => {
            map.remove(*last);
        }
        (Json::Array(items), value) => {
            let i = last.parse::<usize>().map_err(|_| format!("{last}: not a list index"))?;
            match value {
                Some(v) if i < items.len() => items[i] = v,
                Some(v) if i == items.len() => items.push(v),
                None if i < items.len() => {
                    items.remove(i);
                }
                _ => return Err(format!("no list entry {i}")),
            }
        }
        _ => return Err(format!("{}: not a mapping or list", parents.last().unwrap_or(last))),
    }
    Ok(())
}

/// The YAML document of `text` as resources, for an import: parsed as a config file
/// is (both layouts), with unknown sections dropped and logged, and the plaintext
/// management key hashed.
///
/// The stored layout is the v8 one, where a setting under `oauth.providers` applies to
/// sign-ins only. A setting the file wrote in the older flat layout applied to API keys
/// too; the import says which of those now apply to sign-ins only.
pub fn import_yaml(text: &str) -> anyhow::Result<Vec<Resource>> {
    let cfg = Config::parse(text)?;
    let scoped = cfg.oauth_only.clone();
    let mut doc = cpa_core::config::ConfigDocument::unmigrated(cfg.document);
    for (path, _) in doc.archive_unknown() {
        tracing::warn!("import: unknown setting {path} was not imported");
    }
    let mut json = serde_json::to_value(cpa_core::config::AsJson(doc.value()))?;
    drop_unknown_fields(&mut json);
    let mut resources = split(&json, &[]).map_err(|e| anyhow::anyhow!("{e}"))?;
    for r in &mut resources {
        hash_management_key(r).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    if let Ok((compiled, _)) = config(&resources) {
        for path in compiled.oauth_only.difference(&scoped) {
            tracing::warn!("import: {path} was written in the old flat layout and now applies to sign-ins only");
        }
    }
    Ok(resources)
}

/// Removes the fields strict validation does not know inside lists (an old provider
/// key's `websockets`), which `archive_unknown` leaves, logging each.
fn drop_unknown_fields(doc: &mut Json) {
    // Each pass removes one field; a config has far fewer.
    for _ in 0..10_000 {
        let Ok(yaml) = serde_yaml_ng::to_value(&*doc) else {
            return;
        };
        let Err(e) = cpa_core::config::validate_config_fields(&yaml, true) else {
            return;
        };
        let message = format!("{e:#}");
        let Some(path) = message.strip_prefix("unknown setting config.") else {
            return;
        };
        let path = path.split_whitespace().next().unwrap_or_default();
        // `a.b[0].c` as pointer segments.
        let parts: Vec<String> = path
            .split('.')
            .flat_map(|p| p.split('[').map(|s| s.trim_end_matches(']').to_owned()))
            .filter(|s| !s.is_empty())
            .collect();
        let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
        if at_path(doc, &parts).is_none() || set_path(doc, &parts, None).is_err() {
            return;
        }
        tracing::warn!("import: unknown setting {path} was not imported");
    }
}

#[cfg(test)]
mod tests;
