use std::collections::{BTreeMap, HashSet};

use cpa_core::config::Config;
use serde_json::{Map, Value as Json};

use super::{
    FAMILIES, Fault, Kind, MAX_RESOURCES, MAX_STATE_BYTES, PROVENANCE, Resource, SECRET, bounded, check, plugin,
    provenance, secrets, strip_provider_annotations, strip_provider_read_annotations, valid_id,
};

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
            if r.kind == Kind::Provider && !annotate {
                strip_provider_annotations(map);
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
            Kind::Setting if r.id == PROVENANCE => {}
            Kind::Setting => {
                root.insert(r.id.clone(), r.spec.clone());
            }
            Kind::Provider => {
                let family = r.spec.get("type").and_then(Json::as_str).unwrap_or_default();
                let slot = FAMILIES.iter().position(|f| *f == family).unwrap_or(FAMILIES.len());
                families.entry(slot).or_default().push(entry(r, Some("type")));
            }
            Kind::ClientKey => keys.push(if annotate {
                serde_json::json!({"@id": r.id, "key": r.spec.get("key").cloned().unwrap_or(Json::Null)})
            } else {
                r.spec.get("key").cloned().unwrap_or(Json::Null)
            }),
            Kind::Router => routers.push(entry(r, None)),
            Kind::Plugin => {
                plugins.insert(r.id.clone(), plugin::document_spec(r));
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
    if resources.len() > MAX_RESOURCES
        || resources
            .iter()
            .map(|r| {
                r.spec.to_string().len()
                    + serde_json::to_string(&r.description).expect("JSON string").len()
                    + serde_json::to_string(&r.id).expect("JSON string").len()
                    + 128
            })
            .sum::<usize>()
            > MAX_STATE_BYTES
    {
        return Err(Fault::new(None, "config exceeds the resource or state size limit"));
    }
    let doc = document(resources, false);
    let yaml: serde_yaml_ng::Value =
        serde_yaml_ng::to_value(&doc).map_err(|e| Fault::new(None, format!("config is not YAML: {e}")))?;
    cpa_core::config::validate_config_fields(&yaml, true).map_err(|error| validation_fault(resources, error))?;
    let text = cpa_core::config::yaml_string(&yaml).map_err(|e| Fault::new(None, e.to_string()))?;
    let mut cfg = Config::parse_payload(&text).map_err(|e| Fault::new(None, format!("{e:#}")))?;
    if let Some(paths) = resources
        .iter()
        .find(|r| r.kind == Kind::Setting && r.id == PROVENANCE)
        .and_then(|r| r.spec.get("global-oauth-paths"))
        .and_then(Json::as_array)
    {
        for path in paths.iter().filter_map(Json::as_str) {
            if !cfg.oauth_only.remove(path) {
                return Err(Fault::new(
                    Some(format!("setting/{PROVENANCE}")),
                    "unknown or duplicate OAuth scope provenance",
                ));
            }
        }
    }
    plugin::restore_raw(resources, &mut cfg)?;
    Ok((cfg, text))
}

fn validation_fault(resources: &[Resource], error: anyhow::Error) -> Fault {
    let mut fault = Fault::new(None, format!("{error:#}"));
    let Some(path) = error.downcast_ref::<cpa_core::config::ValidationPath>() else {
        return fault;
    };
    let parts: Vec<_> = path.pointer.split('/').skip(1).collect();
    let mut candidates: Vec<_> = resources.iter().collect();
    candidates.sort_by(|a, b| (a.ord, &a.id).cmp(&(b.ord, &b.id)));
    let (resource, prefix, suffix) = match parts.as_slice() {
        ["api-keys", family, index, ..] => (
            candidates
                .iter()
                .copied()
                .filter(|r| r.kind == Kind::Provider && r.group() == *family)
                .nth(index.parse().unwrap_or(usize::MAX)),
            3,
            "",
        ),
        ["access", "api-keys", index, ..] => (
            candidates
                .iter()
                .copied()
                .filter(|r| r.kind == Kind::ClientKey)
                .nth(index.parse().unwrap_or(usize::MAX)),
            3,
            "/key",
        ),
        ["model-routers", index, ..] => (
            candidates
                .iter()
                .copied()
                .filter(|r| r.kind == Kind::Router)
                .nth(index.parse().unwrap_or(usize::MAX)),
            2,
            "",
        ),
        ["plugins", "configs", id, ..] => (
            candidates
                .iter()
                .copied()
                .find(|r| r.kind == Kind::Plugin && r.id == id.replace("~1", "/").replace("~0", "~")),
            3,
            "",
        ),
        [section, ..] => (
            candidates
                .iter()
                .copied()
                .find(|r| r.kind == Kind::Setting && r.id == section.replace("~1", "/").replace("~0", "~")),
            1,
            "",
        ),
        [] => (None, 0, ""),
    };
    if let Some(resource) = resource {
        fault.resource = Some(resource.key());
        fault.pointer = Some(format!(
            "{suffix}{}",
            parts[prefix..]
                .iter()
                .map(|part| format!("/{part}"))
                .collect::<String>()
        ));
    }
    fault
}

/// `doc` as resources. Entries keep the id of the resource in `old` they came from:
/// providers and routers by `"@id"`, then routers by name, client keys by value,
/// plugins and settings by key. Others get an id from their `name`, else a numbered
/// one. Descriptions and creation revisions carry over from `old`.
pub fn split(doc: &Json, old: &[Resource]) -> Result<Vec<Resource>, Fault> {
    if !bounded(doc) || doc.to_string().len() > MAX_STATE_BYTES {
        return Err(Fault::new(None, "config exceeds size or depth limits"));
    }
    let root = doc
        .as_object()
        .ok_or_else(|| Fault::new(None, "config must be a mapping"))?;
    let mut out: Vec<Resource> = Vec::new();
    let mut taken: HashSet<(Kind, String)> = HashSet::new();
    // An id for a new entry: the one asked for when free, else its name, else `base-N`.
    let mut assign = |kind: Kind, asked: Option<Json>, name: Option<&str>, base: &str| -> Result<String, Fault> {
        let free = |id: &str| valid_id(id) && !taken.contains(&(kind, id.to_owned()));
        let id = if let Some(asked) = asked {
            let id = asked
                .as_str()
                .filter(|id| free(id))
                .ok_or_else(|| Fault::new(None, "invalid or duplicate @id annotation"))?;
            id.to_owned()
        } else if let Some(name) = name.map(str::trim).filter(|id| free(id)) {
            name.to_owned()
        } else {
            (1..)
                .map(|n| format!("{base}-{n}"))
                .find(|id| free(id) && !old.iter().any(|r| r.kind == kind && r.id == *id))
                .expect("unbounded")
        };
        taken.insert((kind, id.clone()));
        Ok(id)
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
    for (key, value) in root {
        match key.as_str() {
            "config-version" if value == &Json::from(8) => {}
            "api-keys" => {
                let Some(families) = value.as_object() else {
                    if value.is_null() {
                        continue;
                    }
                    return Err(Fault::new(None, "api-keys must be a mapping of provider types"));
                };
                for (family, list) in families {
                    if !FAMILIES.contains(&family.as_str()) {
                        return Err(Fault::new(None, "unknown provider family"));
                    }
                    for (i, item) in list.as_array().into_iter().flatten().enumerate() {
                        let mut spec = entry_object(item, &format!("api-keys.{family}[{i}]"))?;
                        strip_provider_read_annotations(&mut spec);
                        let asked = spec.remove("@id");
                        let name = spec.get("name").and_then(Json::as_str).map(str::to_owned);
                        let id = assign(Kind::Provider, asked, name.as_deref(), family)?;
                        spec.insert("type".into(), family.clone().into());
                        push(Kind::Provider, id, Json::Object(spec), &mut out);
                    }
                    if !list.is_array() && !list.is_null() {
                        return Err(Fault::new(None, format!("api-keys.{family} must be a list")));
                    }
                }
            }
            "model-routers" => {
                if !value.is_array() {
                    return Err(Fault::new(None, "model-routers must be a list"));
                }
                for (i, item) in value.as_array().into_iter().flatten().enumerate() {
                    let mut spec = entry_object(item, &format!("model-routers[{i}]"))?;
                    let asked = spec.remove("@id");
                    let name = spec.get("name").and_then(Json::as_str).map(str::to_owned);
                    let id = assign(Kind::Router, asked, name.as_deref(), "router")?;
                    push(Kind::Router, id, Json::Object(spec), &mut out);
                }
            }
            "access" | "plugins" if value.is_object() => {
                let mut rest = value.as_object().cloned().unwrap_or_default();
                if key == "access" {
                    let keys = rest.remove("api-keys").unwrap_or(Json::Null);
                    if !keys.is_null() && !keys.is_array() {
                        return Err(Fault::new(None, "access.api-keys must be a list"));
                    }
                    for k in keys.as_array().into_iter().flatten() {
                        let (asked, text) = if let Some(map) = k.as_object() {
                            if map.keys().any(|k| k != "@id" && k != "key") {
                                return Err(Fault::new(None, "invalid client key annotation"));
                            }
                            (map.get("@id").cloned(), map.get("key").and_then(Json::as_str))
                        } else {
                            (None, k.as_str())
                        };
                        let text = text.ok_or_else(|| Fault::new(None, "client key must be a string"))?;
                        if text == SECRET && asked.is_none() {
                            return Err(Fault::new(None, "masked client key requires @id"));
                        }
                        let known = old.iter().find(|r| {
                            r.kind == Kind::ClientKey && r.spec.get("key").and_then(Json::as_str) == Some(text)
                        });
                        let id = assign(
                            Kind::ClientKey,
                            asked.or_else(|| known.map(|r| Json::String(r.id.clone()))),
                            None,
                            "key",
                        )?;
                        push(Kind::ClientKey, id, serde_json::json!({ "key": text }), &mut out);
                    }
                } else {
                    plugin::split_configs(rest.remove("configs").unwrap_or(Json::Null), old, &mut out)?;
                }
                if !rest.is_empty() {
                    push(Kind::Setting, key.clone(), Json::Object(rest), &mut out);
                }
            }
            _ if key == PROVENANCE => return Err(Fault::new(None, "config provenance is reserved")),
            _ => push(Kind::Setting, key.clone(), value.clone(), &mut out),
        }
    }
    if let Some(before) = old.iter().find(|r| r.kind == Kind::Setting && r.id == PROVENANCE) {
        let mut scope = Resource::new(Kind::Setting, PROVENANCE, 0, before.spec.clone());
        if provenance::retain_scope(&mut scope, &document(old, false), doc, secrets::same_with_placeholders) {
            out.push(scope);
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
