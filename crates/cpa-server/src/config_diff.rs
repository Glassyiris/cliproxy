//! Reload summaries by configuration resource. Resource values are never logged.
use std::collections::BTreeMap;

use cpa_core::config::Config;

use crate::config_store::resources;

fn details(old: &Config, new: &Config) -> anyhow::Result<Vec<String>> {
    let split = |cfg: &Config| -> anyhow::Result<BTreeMap<_, _>> {
        Ok(resources::split(&serde_json::to_value(&cfg.document)?, &[])
            .map_err(|_| anyhow::anyhow!("could not split config resources"))?
            .into_iter()
            .map(|r| (r.key(), r))
            .collect())
    };
    let mut old = split(old)?;
    let new = split(new)?;
    let mut changes = Vec::new();
    for (key, resource) in new {
        let action = match old.remove(&key) {
            None => "added",
            Some(before) if !before.same_content(&resource) => "changed",
            Some(_) => continue,
        };
        changes.push(format!("{} {action}", resources::redacted(&resource).key()));
    }
    for resource in old.into_values() {
        changes.push(format!("{} removed", resources::redacted(&resource).key()));
    }
    Ok(changes)
}

pub(crate) fn log(old: &Config, new: &Config) {
    match details(old, new) {
        Ok(changes) => {
            for change in changes {
                tracing::info!("config resource {change}");
            }
        }
        // A split error can contain user input; keep it out of the log as well.
        Err(_) => tracing::warn!("could not summarize config resource changes"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_reload_summary_never_includes_values() {
        let parse = |text: &str| Config::parse(text).unwrap();
        let old = parse(
            "config-version: 8\nserver: {port: 8080}\napi-keys:\n  claude:\n    - name: removed\n      keys: [{api-key: fixture-secret-old}]\n    - name: retained\n      keys: [{api-key: fixture-secret-before}]\n",
        );
        let new = parse(
            "config-version: 8\nserver: {port: 8081}\napi-keys:\n  claude:\n    - name: added\n      keys: [{api-key: fixture-secret-new}]\n    - name: retained\n      keys: [{api-key: fixture-secret-after}]\n",
        );
        let changes = details(&old, &new).unwrap();
        assert_eq!(
            changes,
            [
                "provider/added added",
                "provider/retained changed",
                "setting/server changed",
                "provider/removed removed",
            ]
        );
        assert!(!changes.join("\n").contains("fixture-secret"));
        assert!(details(&new, &new).unwrap().is_empty());
    }
}
