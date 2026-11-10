//! The resource model of the config store, without SQL: how stored resources compile
//! into the config document the runtime reads, and how a document splits back into
//! resources. Everything here works on the JSON form of the document.

use std::collections::HashSet;

use serde::Serialize;
use serde_json::Value as Json;

mod annotations;
mod document;
mod io;
mod plugin;
mod provenance;
mod secrets;

pub use annotations::strip_read_annotations_at;
use annotations::{strip_provider_annotations, strip_provider_read_annotations};
pub use document::{at_path, config, document, set_path, split};
pub use io::{ImportError, export_json, import_json, import_yaml};
pub(crate) use plugin::RAW_YAML;
pub use plugin::patch_plugin_controls;
pub use provenance::preserve_scope;
pub use secrets::{document_for_read, hash_management_key, redact_document, redacted, resolve_secrets};

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

/// What replaces a secret in ordinary reads, history and exports. Writes keep the
/// stored value by resource and nested entry identity, never by list position.
pub const SECRET: &str = "$secret";

pub const PROVENANCE: &str = "@store-provenance";
pub const MAX_RESOURCES: usize = 10_000;
pub const MAX_SPEC_BYTES: usize = 1 << 20;
pub const MAX_STATE_BYTES: usize = 16 << 20;
pub const MAX_DEPTH: usize = 64;

/// Bounds JSON before recursive processing or allocation of a compiled document.
pub fn bounded(value: &Json) -> bool {
    let mut pending = vec![(value, 0)];
    let mut nodes = 0usize;
    while let Some((value, depth)) = pending.pop() {
        nodes += 1;
        if depth > MAX_DEPTH || nodes > MAX_SPEC_BYTES {
            return false;
        }
        match value {
            Json::Array(items) => pending.extend(items.iter().map(|v| (v, depth + 1))),
            Json::Object(map) => pending.extend(map.values().map(|v| (v, depth + 1))),
            _ => {}
        }
    }
    true
}

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
    pub pointer: Option<String>,
    pub code: Option<&'static str>,
    pub pointers: Vec<String>,
}

impl Fault {
    pub fn new(resource: Option<String>, message: impl Into<String>) -> Self {
        Self {
            resource,
            message: message.into(),
            pointer: None,
            code: None,
            pointers: Vec::new(),
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
    if !bounded(&r.spec) || r.spec.to_string().len() > MAX_SPEC_BYTES || r.description.len() > 4096 {
        return fault("resource exceeds the size or depth limit");
    }
    if r.kind == Kind::Setting && r.id == PROVENANCE {
        return match r.spec.as_object() {
            Some(m)
                if m.len() == 1
                    && m.get("global-oauth-paths")
                        .and_then(Json::as_array)
                        .is_some_and(|paths| {
                            paths.iter().all(|p| {
                                p.as_str()
                                    .is_some_and(|p| p.starts_with("oauth.providers.") && p.len() < 256)
                            })
                        }) =>
            {
                Ok(())
            }
            _ => fault("invalid config scope provenance"),
        };
    }
    if r.kind == Kind::Provider {
        let mut ids = HashSet::new();
        for key in r.spec.get("keys").and_then(Json::as_array).into_iter().flatten() {
            if let Some(id) = key.get("@id")
                && !id.as_str().is_some_and(|id| valid_id(id) && ids.insert(id))
            {
                return fault("invalid or duplicate provider key @id");
            }
        }
    }
    plugin::check(r)?;
    match r.kind {
        Kind::Setting if NOT_SETTINGS.contains(&r.id.as_str()) => {
            fault("this section is stored as provider, router or plugin resources")
        }
        Kind::Setting if r.id == "access" && r.spec.get("api-keys").is_some() => {
            fault("client keys are client-key resources, not part of setting/access")
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
        Kind::Router if !r.spec.is_object() => fault("spec must be an object"),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests;
