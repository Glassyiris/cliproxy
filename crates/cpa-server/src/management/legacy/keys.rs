//! Go's provider key list and OAuth map sanitizers (`config_normalization.go`,
//! `vertex_compat.go`) on the typed JSON view the reload diff compares. Entries keep
//! Go's JSON shape, which is also their YAML shape: the tags coincide for these structs.
use std::collections::{BTreeMap, HashSet};

use cpa_common::gostr::GoStr;
use serde_json::{Map, Value};

use super::go_trim;
use super::view::{self, Shape};

pub(super) fn lower(s: &str) -> String {
    cpa_common::gostr::lower_bytes(s.as_bytes())
}

fn text(o: &Map<String, Value>, k: &str) -> String {
    o.get(k).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// Go `normalizeModelPrefix`.
pub(super) fn normalize_prefix(prefix: &str) -> String {
    let p = go_trim(prefix).trim_matches('/');
    if p.contains('/') { String::new() } else { p.to_owned() }
}

/// Go `NormalizeHeaders`: trimmed, empties dropped, nil when nothing is left.
pub(super) fn normalize_headers(v: &Value) -> Value {
    let Some(map) = v.as_object() else { return Value::Null };
    let clean: BTreeMap<String, Value> = map
        .iter()
        .filter_map(|(k, v)| {
            let (k, v) = (go_trim(k), go_trim(v.as_str().unwrap_or_default()));
            (!k.is_empty() && !v.is_empty()).then(|| (k.to_owned(), Value::from(v)))
        })
        .collect();
    if clean.is_empty() {
        Value::Null
    } else {
        Value::Object(clean.into_iter().collect())
    }
}

/// Go `NormalizeExcludedModels`.
pub(super) fn normalize_excluded(v: &Value) -> Value {
    let mut seen = HashSet::new();
    let out: Vec<Value> = v
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let m = lower(go_trim(m.as_str().unwrap_or_default()));
            (!m.is_empty() && seen.insert(m.clone())).then(|| Value::from(m))
        })
        .collect();
    if out.is_empty() { Value::Null } else { Value::Array(out) }
}

/// Go `FormatSortedHeaders`.
fn sorted_headers(v: Option<&Value>) -> String {
    let mut out = String::new();
    let map: BTreeMap<&String, &Value> = v.and_then(Value::as_object).into_iter().flatten().collect();
    for (k, v) in map {
        out.push_str(k);
        out.push('\0');
        out.push_str(v.as_str().unwrap_or_default());
        out.push('\0');
    }
    out
}

/// Drops `omitempty` fields that a sanitizer emptied.
fn prune(shape: &Shape, entry: &mut Value) {
    if let Some(o) = entry.as_object_mut() {
        for f in shape.fields.iter().filter(|f| f.omit) {
            let empty = match o.get(&f.json) {
                Some(Value::Null) => true,
                Some(Value::Bool(b)) => !b && !f.ptr,
                Some(Value::String(s)) => s.is_empty(),
                Some(Value::Number(n)) => n.as_f64() == Some(0.0) && !f.ptr,
                Some(Value::Array(a)) => a.is_empty(),
                Some(Value::Object(m)) => f.kind == "map" && m.is_empty(),
                None => false,
            };
            if empty {
                o.shift_remove(&f.json);
            }
        }
    }
}

fn set_str(o: &mut Map<String, Value>, k: &str, v: String) {
    if o.contains_key(k) || !v.is_empty() {
        o.insert(k.into(), v.into());
    }
}

/// Rewrites one string field in place.
fn fix(o: &mut Map<String, Value>, k: &str, f: impl FnOnce(&str) -> String) {
    let v = f(o.get(k).and_then(Value::as_str).unwrap_or_default());
    set_str(o, k, v);
}

fn trim(v: &str) -> String {
    go_trim(v).to_owned()
}

/// One sanitized entry, or `None` when Go drops it. `family` is the legacy list name.
fn entry(family: &str, e: &Value) -> Option<Value> {
    let mut o = e.as_object()?.clone();
    let trimmed = |o: &Map<String, Value>, k: &str| go_trim(&text(o, k)).to_owned();
    let (key, base) = (trimmed(&o, "api-key"), trimmed(&o, "base-url"));
    match family {
        "gemini-api-key" | "interactions-api-key" => {
            if key.is_empty() && base.is_empty() {
                return None;
            }
            set_str(&mut o, "api-key", key);
            set_str(&mut o, "base-url", base);
            fix(&mut o, "prefix", normalize_prefix);
            fix(&mut o, "proxy-url", trim);
        }
        "codex-api-key" | "xai-api-key" => {
            if base.is_empty() {
                return None;
            }
            set_str(&mut o, "base-url", base);
            fix(&mut o, "prefix", normalize_prefix);
            if family == "xai-api-key" {
                o.shift_remove("alpha-search");
            }
        }
        "meta-api-key" => {
            if key.is_empty() || key.starts_with("dca:") {
                return None;
            }
            set_str(&mut o, "api-key", key);
            fix(&mut o, "prefix", normalize_prefix);
            let base = if base.is_empty() {
                "https://api.meta.ai/v1".to_owned()
            } else {
                base
            };
            o.insert("base-url".into(), base.into());
            o.shift_remove("alpha-search");
        }
        "claude-api-key" => {
            fix(&mut o, "prefix", normalize_prefix);
            if let Some(cloak) = o.get_mut("cloak").and_then(Value::as_object_mut) {
                let mode = go_trim(cloak.get("mode").and_then(Value::as_str).unwrap_or_default()).to_owned();
                cloak.insert("mode".into(), mode.into());
                let words: Vec<Value> = cloak
                    .get("sensitive-words")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|w| Some(go_trim(w.as_str()?)).filter(|w| !w.is_empty()).map(Value::from))
                    .collect();
                if words.is_empty() {
                    cloak.shift_remove("sensitive-words");
                } else {
                    cloak.insert("sensitive-words".into(), Value::Array(words));
                }
            }
            if let (Some(cloak), Some(shape)) = (o.get_mut("cloak"), view::nested("claude-api-key", "cloak")) {
                prune(shape, cloak);
            }
            let profile = text(&o, "fingerprint-profile");
            let normalized = match lower(go_trim(&profile)).as_str() {
                "claude-code-cli" | "oauth-cli" => "claude-code-cli".to_owned(),
                "default" => "default".to_owned(),
                _ => go_trim(&profile).to_owned(),
            };
            set_str(&mut o, "fingerprint-profile", normalized);
        }
        "vertex-api-key" => {
            if key.is_empty() {
                return None;
            }
            set_str(&mut o, "api-key", key);
            fix(&mut o, "prefix", normalize_prefix);
            set_str(&mut o, "base-url", base);
            fix(&mut o, "proxy-url", trim);
            let models: Vec<Value> = o
                .get("models")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|m| {
                    let mut m = m.as_object()?.clone();
                    let (alias, name) = (trimmed(&m, "alias"), trimmed(&m, "name"));
                    // v8.0.35 (d9451cb6) keeps a model without an alias.
                    if name.is_empty() {
                        return None;
                    }
                    m.insert("alias".into(), alias.into());
                    m.insert("name".into(), name.into());
                    Some(Value::Object(m))
                })
                .collect();
            o.insert("models".into(), Value::Array(models));
        }
        "openai-compatibility" => {
            if base.is_empty() {
                return None;
            }
            fix(&mut o, "name", trim);
            fix(&mut o, "prefix", normalize_prefix);
            set_str(&mut o, "base-url", base);
        }
        _ => {}
    }
    if let Some(h) = o.get("headers").map(normalize_headers) {
        o.insert("headers".into(), h);
    }
    if family != "openai-compatibility"
        && let Some(x) = o.get("excluded-models").map(normalize_excluded)
    {
        o.insert("excluded-models".into(), x);
    }
    let mut out = Value::Object(o);
    prune(view::field(family).elem.as_deref().expect("list element"), &mut out);
    Some(out)
}

/// Go's sanitizer for one list. A nil list stays nil; Go's dedupe for Gemini-style
/// entries (key, base, proxy, prefix, headers) and Vertex (key, base) applies.
pub(super) fn sanitize(family: &str, list: &Value) -> Value {
    let Some(items) = list.as_array() else {
        return Value::Null;
    };
    if items.is_empty() && family != "gemini-api-key" && family != "interactions-api-key" && family != "vertex-api-key"
    {
        return list.clone();
    }
    let mut seen = HashSet::new();
    let out: Vec<Value> = items
        .iter()
        .filter_map(|e| entry(family, e))
        .filter(|e| {
            let o = e.as_object().expect("entry object");
            let id = match family {
                "gemini-api-key" | "interactions-api-key" => [
                    text(o, "api-key"),
                    text(o, "base-url"),
                    text(o, "proxy-url"),
                    text(o, "prefix"),
                    sorted_headers(o.get("headers")),
                ]
                .join("\0"),
                "vertex-api-key" => format!("{}|{}", text(o, "api-key"), text(o, "base-url")),
                _ => return true,
            };
            seen.insert(id)
        })
        .collect();
    Value::Array(out)
}

/// `channel -> list` maps: keys trimmed and lowercased, `clean` per list, empties dropped.
fn channel_map(v: &Value, mut clean: impl FnMut(&[Value]) -> Vec<Value>) -> Map<String, Value> {
    let mut out = BTreeMap::new();
    for (channel, list) in v.as_object().into_iter().flatten() {
        let channel = lower(go_trim(channel));
        let list = list.as_array().map(Vec::as_slice).unwrap_or_default();
        if channel.is_empty() || list.is_empty() {
            continue;
        }
        let cleaned = clean(list);
        if !cleaned.is_empty() {
            out.insert(channel, Value::Array(cleaned));
        }
    }
    out.into_iter().collect()
}

/// Go `NormalizeOAuthExcludedModels`: nil when nothing is left.
pub(super) fn oauth_excluded(v: &Value) -> Value {
    if v.as_object().is_none_or(Map::is_empty) {
        return Value::Null;
    }
    let out = channel_map(v, |list| match normalize_excluded(&Value::Array(list.to_vec())) {
        Value::Array(a) => a,
        _ => Vec::new(),
    });
    if out.is_empty() {
        Value::Null
    } else {
        Value::Object(out)
    }
}

/// Prunes `omitempty` fields of a sanitized `channel -> [struct]` map entry.
fn prune_map_entry(map: &str, entry: &mut Value) {
    if let Some(shape) = view::field(map).elem.as_deref().and_then(|l| l.elem.as_deref()) {
        prune(shape, entry);
    }
}

/// Go `SanitizeOAuthModelAlias`.
pub(super) fn oauth_alias(v: &Value) -> Value {
    if v.as_object().is_none_or(Map::is_empty) {
        return v.clone();
    }
    Value::Object(channel_map(v, |list| {
        let mut seen = HashSet::new();
        list.iter()
            .filter_map(|e| {
                let e = e.as_object()?;
                let (name, alias) = (
                    go_trim(&text(e, "name")).to_owned(),
                    go_trim(&text(e, "alias")).to_owned(),
                );
                if name.is_empty() || alias.is_empty() || name.go_eq_fold(&alias) || !seen.insert(lower(&alias)) {
                    return None;
                }
                let mut o = e.clone();
                o.insert("name".into(), name.into());
                o.insert("alias".into(), alias.into());
                if let Some(d) = o
                    .get("display-name")
                    .and_then(Value::as_str)
                    .map(|d| go_trim(d).to_owned())
                {
                    o.insert("display-name".into(), d.into());
                }
                let mut o = Value::Object(o);
                prune_map_entry("oauth-model-alias", &mut o);
                Some(o)
            })
            .collect()
    }))
}

/// Go `SanitizeOAuthSettings`: the last of each name/alias pair wins, order kept.
pub(super) fn oauth_settings(v: &Value) -> Value {
    if v.as_object().is_none_or(Map::is_empty) {
        return v.clone();
    }
    Value::Object(channel_map(v, |list| {
        let mut seen = HashSet::new();
        let mut kept: Vec<Value> = list
            .iter()
            .rev()
            .filter_map(|e| {
                let e = e.as_object()?;
                let name = go_trim(&text(e, "name")).to_owned();
                let alias = go_trim(&text(e, "alias")).to_owned();
                if name.is_empty() || !seen.insert(format!("{}->{}", lower(&name), lower(&alias))) {
                    return None;
                }
                let mut o = e.clone();
                o.insert("name".into(), name.into());
                o.insert("alias".into(), alias.into());
                let mut o = Value::Object(o);
                prune_map_entry("oauth-settings", &mut o);
                Some(o)
            })
            .collect();
        kept.reverse();
        kept
    }))
}

/// Go `SanitizeOAuthRequestScopedErrors`: nil when nothing is left.
pub(super) fn oauth_scoped_errors(v: &Value) -> Value {
    if v.as_object().is_none_or(Map::is_empty) {
        return v.clone();
    }
    let out = channel_map(v, |list| {
        list.iter()
            .filter_map(|r| {
                let r = r.as_object()?;
                let words = |k: &str| -> Vec<Value> {
                    r.get(k)
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|w| Some(go_trim(w.as_str()?)).filter(|w| !w.is_empty()).map(Value::from))
                        .collect()
                };
                let (matches, regexes) = (words("match"), words("match-regexr"));
                let action = lower(go_trim(&text(r, "action")));
                let status = r.get("status").and_then(Value::as_i64).unwrap_or(0);
                if status <= 0 || (matches.is_empty() && regexes.is_empty()) || action.is_empty() {
                    return None;
                }
                let mut o = Map::new();
                o.insert("status".into(), status.into());
                o.insert("match".into(), matches.into());
                o.insert("match-regexr".into(), regexes.into());
                o.insert("action".into(), action.into());
                let mut out = Value::Object(o);
                prune_map_entry("oauth-request-scoped-errors", &mut out);
                Some(out)
            })
            .collect()
    });
    if out.is_empty() {
        Value::Null
    } else {
        Value::Object(out)
    }
}

/// Every load-time sanitizer, applied to the whole GET /config view.
pub(super) fn normalize_config(cfg: &mut Value) {
    let Some(c) = cfg.as_object_mut() else { return };
    for (family, _) in view::KEY_FAMILIES {
        if let Some(list) = c.get(family) {
            let clean = sanitize(family, list);
            c.insert(family.into(), clean);
        }
    }
    for (k, f) in [
        ("oauth-excluded-models", oauth_excluded as fn(&Value) -> Value),
        ("oauth-model-alias", oauth_alias),
        ("oauth-settings", oauth_settings),
        ("oauth-request-scoped-errors", oauth_scoped_errors),
    ] {
        if let Some(v) = c.get(k).map(f) {
            if v.is_null() || v.as_object().is_some_and(Map::is_empty) {
                c.shift_remove(k);
            } else {
                c.insert(k.into(), v);
            }
        }
    }
}
