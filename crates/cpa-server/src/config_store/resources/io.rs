use std::collections::HashSet;

use cpa_core::config::Config;
use serde_json::Value as Json;

use super::{
    Fault, Kind, MAX_RESOURCES, MAX_STATE_BYTES, Resource, check, hash_management_key, redacted,
    resolve_secrets, split, strip_read_annotations_at,
};

const EXPORT_FORMAT: &str = "cook-router-config";
const EXPORT_VERSION: u64 = 1;

#[derive(Debug)]
pub struct ImportError {
    pub status: u16,
    pub code: &'static str,
    pub fault: Box<Fault>,
}

impl ImportError {
    fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            fault: Box::new(Fault::new(None, message)),
        }
    }

    fn invalid(fault: Fault) -> Self {
        Self {
            status: 422,
            code: "invalid_config",
            fault: Box::new(fault),
        }
    }
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.fault.fmt(f)
    }
}

impl std::error::Error for ImportError {}

/// Imports the current layout; a field the schema does not know is an error.
pub fn import_yaml(text: &str) -> anyhow::Result<Vec<Resource>> {
    anyhow::ensure!(text.len() <= MAX_STATE_BYTES, "config exceeds size limit");
    let cfg = Config::parse(text)?;
    let json = strip_read_annotations_at(serde_json::to_value(cpa_core::config::AsJson(&cfg.document))?, &[]);
    cpa_core::config::validate_config_fields(&serde_yaml_ng::to_value(&json)?, true)?;
    let mut resources = split(&json, &[]).map_err(|e| anyhow::anyhow!("{e}"))?;
    for r in &mut resources {
        resolve_secrets(r, None).map_err(|e| anyhow::anyhow!("{e}"))?;
        hash_management_key(r).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    resources.sort_by(|a, b| (a.kind, a.ord, &a.id).cmp(&(b.kind, b.ord, &b.id)));
    Ok(resources)
}

/// Lossless resource export; ordinary exports never include credential material.
pub fn export_json(rev: u64, resources: &[Resource], include_secrets: bool) -> Json {
    let resources: Vec<Json> = resources
        .iter()
        .map(|r| {
            let shown;
            let r = if include_secrets {
                r
            } else {
                shown = redacted(r);
                &shown
            };
            serde_json::json!({"kind":r.kind,"id":r.id,"ord":r.ord,"description":r.description,"spec":r.spec})
        })
        .collect();
    serde_json::json!({"format":EXPORT_FORMAT,"version":EXPORT_VERSION,"revision":rev,"resources":resources})
}

/// Reads only the explicitly versioned resource export, without silently dropping fields.
pub fn import_json(text: &str) -> Result<Vec<Resource>, ImportError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Export {
        format: String,
        version: u64,
        #[serde(rename = "revision")]
        _revision: u64,
        resources: Vec<Entry>,
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Entry {
        kind: String,
        id: String,
        #[serde(default)]
        ord: i64,
        #[serde(default)]
        description: String,
        spec: Json,
    }
    if text.len() > MAX_STATE_BYTES {
        return Err(ImportError::new(
            422,
            "invalid_config",
            "config export exceeds size limit",
        ));
    }
    let export: Export =
        serde_json::from_str(text).map_err(|error| ImportError::new(400, "invalid_body", error.to_string()))?;
    if export.format != EXPORT_FORMAT || export.version != EXPORT_VERSION {
        return Err(ImportError::new(
            422,
            "invalid_export",
            "unsupported config export format or version",
        ));
    }
    if export.resources.len() > MAX_RESOURCES {
        return Err(ImportError::new(422, "invalid_config", "too many config resources"));
    }
    let mut ids = HashSet::new();
    export
        .resources
        .into_iter()
        .map(|entry| {
            let kind = Kind::parse(&entry.kind)
                .ok_or_else(|| ImportError::new(422, "unknown_kind", "unknown resource kind"))?;
            if !ids.insert((kind, entry.id.clone())) {
                return Err(ImportError::invalid(Fault::new(
                    Some(format!("{}/{}", kind.name(), entry.id)),
                    "duplicate config resource",
                )));
            }
            let mut r = Resource::new(kind, entry.id, entry.ord, entry.spec);
            r.description = entry.description;
            check(&r).map_err(ImportError::invalid)?;
            Ok(r)
        })
        .collect()
}
