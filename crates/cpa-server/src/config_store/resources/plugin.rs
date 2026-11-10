use cpa_core::config::Config;
use serde_json::Value as Json;

use super::{Fault, Kind, Resource, SECRET, valid_id};

use super::secrets::secret_pointers;

pub(crate) const RAW_YAML: &str = "@raw-yaml";

pub(super) fn check(r: &Resource) -> Result<(), Fault> {
    let message = if r.kind == Kind::Setting && r.id == "plugins" && r.spec.get("configs").is_some() {
        "plugin configs are plugin resources, not part of setting/plugins"
    } else if r.kind == Kind::Plugin && r.spec != SECRET && !r.spec.is_object() && !r.spec.is_null() {
        "spec must be an object or null"
    } else {
        return Ok(());
    };
    Err(Fault::new(Some(r.key()), message))
}

pub(super) fn document_spec(r: &Resource) -> Json {
    let mut spec = r.spec.clone();
    if let Some(map) = spec.as_object_mut() {
        map.remove(RAW_YAML);
    }
    spec
}

pub(super) fn restore_raw(resources: &[Resource], cfg: &mut Config) -> Result<(), Fault> {
    for r in resources.iter().filter(|r| r.kind == Kind::Plugin) {
        if let Some(raw) = r.spec.get(RAW_YAML) {
            let value = raw
                .get("value")
                .and_then(Json::as_str)
                .ok_or_else(|| Fault::new(Some(r.key()), "invalid raw plugin YAML"))?;
            let baseline = document_spec(r);
            if raw.get("baseline") != Some(&baseline) {
                return Err(Fault::new(Some(r.key()), "raw plugin YAML does not match its document"));
            }
            let node: serde_yaml_ng::Value =
                serde_yaml_ng::from_str(value).map_err(|_| Fault::new(Some(r.key()), "invalid raw plugin YAML"))?;
            let semantic = raw_document(&node).map_err(|_| Fault::new(Some(r.key()), "invalid raw plugin scalars"))?;
            if serde_json::to_value(cpa_core::config::AsJson(&semantic)).ok().as_ref() != Some(&baseline) {
                return Err(Fault::new(Some(r.key()), "raw plugin YAML does not match its document"));
            }
            if cfg.plugin_configs.is_null() {
                cfg.plugin_configs = serde_yaml_ng::Value::Mapping(Default::default());
            }
            cfg.plugin_configs
                .as_mapping_mut()
                .ok_or_else(|| Fault::new(Some(r.key()), "invalid plugin configs"))?
                .insert(r.id.clone().into(), node);
        }
    }
    Ok(())
}

pub(super) fn split_configs(configs: Json, old: &[Resource], out: &mut Vec<Resource>) -> Result<(), Fault> {
    if !configs.is_null() && !configs.is_object() {
        return Err(Fault::new(None, "plugins.configs must be a mapping"));
    }
    for (name, node) in configs.as_object().into_iter().flatten() {
        if !valid_id(name) {
            return Err(Fault::new(None, format!("plugins.configs: invalid plugin id {name:?}")));
        }
        if node.get(RAW_YAML).is_some() {
            return Err(Fault::new(None, "raw plugin metadata is reserved"));
        }
        let mut node = node.clone();
        if let Some(before) = old.iter().find(|r| r.kind == Kind::Plugin && r.id == *name) {
            let mut baseline = before.spec.clone();
            let raw = baseline.as_object_mut().and_then(|m| m.remove(RAW_YAML));
            if baseline == node
                && let (Some(raw), Some(map)) = (raw, node.as_object_mut())
            {
                map.insert(RAW_YAML.into(), raw);
            }
        }
        out.push(Resource::new(Kind::Plugin, name.clone(), 0, node));
    }
    Ok(())
}

pub(super) fn redact(spec: &mut Json) {
    *spec = SECRET.into();
}

pub(super) fn redact_document(doc: &mut Json) {
    if let Some(configs) = doc.pointer_mut("/plugins/configs").and_then(Json::as_object_mut) {
        configs.values_mut().for_each(redact);
    }
}

pub(super) fn check_replacement(r: &Resource) -> Result<(), Fault> {
    if r.kind == Kind::Plugin && r.spec != SECRET {
        let mut pointers = Vec::new();
        secret_pointers(&r.spec, "", &mut pointers);
        if !pointers.is_empty() {
            let mut fault = Fault::new(Some(r.key()), "send the complete opaque plugin config to replace it");
            fault.code = Some("opaque_config_requires_replacement");
            fault.pointer = pointers.first().cloned();
            fault.pointers = pointers;
            return Err(fault);
        }
    }
    Ok(())
}

pub(super) fn preserve_raw(r: &mut Resource, cfg: &Config) -> anyhow::Result<()> {
    if r.kind == Kind::Plugin
        // Null is already lossless in JSON and represents the host's disabled defaults.
        && !r.spec.is_null()
        && let Some(raw) = cfg.plugin_configs.get(r.id.as_str())
    {
        let baseline = r.spec.clone();
        r.spec
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("plugin config must be a mapping"))?
            .insert(
                RAW_YAML.into(),
                serde_json::json!({"baseline": baseline, "value": serde_yaml_ng::to_string(raw)?}),
            );
    }
    Ok(())
}

fn raw_document(node: &serde_yaml_ng::Value) -> anyhow::Result<serde_yaml_ng::Value> {
    use serde_yaml_ng::Value;
    Ok(match node {
        Value::Tagged(t) if t.tag == cpa_core::config::PLAIN_SCALAR => {
            cpa_core::config::yaml_value(t.value.as_str().ok_or_else(|| anyhow::anyhow!("invalid raw scalar"))?)?
        }
        Value::Tagged(t) => raw_document(&t.value)?,
        Value::Mapping(map) => Value::Mapping(
            map.iter()
                .map(|(k, v)| Ok((raw_document(k)?, raw_document(v)?)))
                .collect::<anyhow::Result<_>>()?,
        ),
        Value::Sequence(items) => Value::Sequence(items.iter().map(raw_document).collect::<anyhow::Result<_>>()?),
        node => node.clone(),
    })
}
/// Only the host's public controls may be patched without revealing plugin config.
/// Null configs retain their shape until a control is assigned a concrete value.
pub fn patch_plugin_controls(r: &mut Resource, patch: &Json) -> Result<(), Fault> {
    let key = r.key();
    let patch = patch
        .as_object()
        .filter(|patch| {
            patch
                .keys()
                .all(|field| matches!(field.as_str(), "enabled" | "priority"))
        })
        .ok_or_else(|| {
            let mut fault = Fault::new(
                Some(key.clone()),
                "opaque plugin config must be replaced in full; only enabled and priority may be patched",
            );
            fault.code = Some("opaque_config_requires_replacement");
            secret_pointers(patch, "", &mut fault.pointers);
            fault.pointer = fault.pointers.first().cloned();
            fault
        })?;
    if r.spec.is_null() {
        if patch.values().all(Json::is_null) {
            return Ok(());
        }
        r.spec = Json::Object(Default::default());
    }
    let map = r
        .spec
        .as_object_mut()
        .ok_or_else(|| Fault::new(Some(key.clone()), "plugin config must be a mapping"))?;
    for (field, value) in patch {
        if value.is_null() {
            map.remove(field);
        } else {
            map.insert(field.clone(), value.clone());
        }
    }
    if let Some(mut raw) = map.remove(RAW_YAML) {
        let text = raw
            .get("value")
            .and_then(Json::as_str)
            .ok_or_else(|| Fault::new(Some(key.clone()), "invalid raw plugin YAML"))?;
        let mut node: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(text).map_err(|_| Fault::new(Some(key.clone()), "invalid raw plugin YAML"))?;
        let yaml = node
            .as_mapping_mut()
            .ok_or_else(|| Fault::new(Some(key.clone()), "plugin config must be a mapping"))?;
        for (field, value) in patch {
            let field = serde_yaml_ng::Value::String(field.clone());
            if value.is_null() {
                yaml.remove(&field);
            } else {
                yaml.insert(
                    field,
                    serde_yaml_ng::to_value(value)
                        .map_err(|_| Fault::new(Some(key.clone()), "invalid plugin control"))?,
                );
            }
        }
        raw["baseline"] = Json::Object(map.clone());
        raw["value"] = serde_yaml_ng::to_string(&node)
            .map_err(|_| Fault::new(Some(key), "invalid raw plugin YAML"))?
            .into();
        map.insert(RAW_YAML.into(), raw);
    }
    Ok(())
}
