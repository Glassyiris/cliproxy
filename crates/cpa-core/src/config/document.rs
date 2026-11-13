//! Config document shape checks and mapping edits, separate from the runtime snapshot.
use anyhow::{Context, bail};
use serde_yaml_ng::{Mapping, Value};

use super::{lookup, validate_shape};

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

#[derive(Clone)]
pub struct ConfigDocument(Value);

impl ConfigDocument {
    #[cfg(test)]
    pub(super) fn parse(text: &str) -> anyhow::Result<Self> {
        let mut root = super::config_value(text)?;
        // Merge keys expand first (Go `expandConfigAliases`): an edit next to an
        // inherited setting must keep it rather than shadow the whole mapping.
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
        root.insert(Value::from("config-version"), Value::from(8));
        Ok(Self(Value::Mapping(root)))
    }

    /// A stored document, taken as it is for resource edits.
    pub fn from_value(value: Value) -> Self {
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

fn merge(dst: &mut Value, src: Value) {
    if let (Value::Mapping(a), Value::Mapping(b)) = (&mut *dst, &src) {
        for (key, value) in b {
            merge(a.entry(key.clone()).or_insert(Value::Null), value.clone());
        }
    } else {
        *dst = src;
    }
}

/// Go `flattenV8`'s shape check: every struct section of the schema that is present
/// must be a mapping. `routing`, `models` and the web search result cache may also be
/// null, which decodes into their zero settings. `root` is the merge-expanded document.
pub(super) fn shape_error(root: &Mapping) -> Option<String> {
    const NULLABLE: [&str; 3] = ["routing", "models", "client.codex.web-search-result-cache"];
    super::schema::struct_paths()
        .iter()
        .find_map(|path| match lookup(root, path) {
            None | Some(Value::Mapping(_)) => None,
            Some(Value::Null) if NULLABLE.contains(&path.as_str()) => None,
            Some(_) => Some(format!("{path} must be a mapping")),
        })
}

/// Go `flattenV8`'s key group expansion (`expandV8Groups`), in schema family order, the
/// group keys' weights included. `root` is the merge-expanded document.
pub(super) fn group_error(root: &Mapping) -> Option<String> {
    let groups = root.get("api-keys").and_then(Value::as_mapping)?;
    for family in super::schema::api_key_families() {
        let Some(groups) = groups.get(family) else {
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
            if family == "openai-compatibility" {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
