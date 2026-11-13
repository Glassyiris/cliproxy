use serde_json::{Map, Value as Json};

use super::FAMILIES;

fn strip_auth_index(map: &mut Map<String, Json>) {
    map.remove("auth_index");
    map.remove("auth-index");
}

pub(super) fn strip_provider_read_annotations(map: &mut Map<String, Json>) {
    strip_auth_index(map);
    for key in map.get_mut("keys").and_then(Json::as_array_mut).into_iter().flatten() {
        if let Some(map) = key.as_object_mut() {
            strip_auth_index(map);
        }
    }
}

pub(super) fn strip_provider_annotations(map: &mut Map<String, Json>) {
    strip_provider_read_annotations(map);
    for key in map.get_mut("keys").and_then(Json::as_array_mut).into_iter().flatten() {
        if let Some(map) = key.as_object_mut() {
            map.remove("@id");
        }
    }
}

/// Removes read annotations only at a known effective-document position.
pub fn strip_read_annotations_at(mut value: Json, path: &[&str]) -> Json {
    strip_at(&mut value, path);
    value
}

fn strip_at(value: &mut Json, path: &[&str]) {
    if path.is_empty() {
        if let Some(providers) = value.get_mut("api-keys") {
            strip_at(providers, &["api-keys"]);
        }
        return;
    }
    if path.first() != Some(&"api-keys") {
        return;
    }
    let strip_entry = |entry: &mut Json| {
        if let Some(map) = entry.as_object_mut() {
            strip_provider_read_annotations(map);
        }
    };
    match path.len() {
        1 => {
            if let Some(families) = value.as_object_mut() {
                for entries in families.values_mut().filter_map(Json::as_array_mut) {
                    entries.iter_mut().for_each(&strip_entry);
                }
            }
        }
        2 if FAMILIES.contains(&path[1]) => {
            if let Some(entries) = value.as_array_mut() {
                entries.iter_mut().for_each(strip_entry);
            }
        }
        3 if FAMILIES.contains(&path[1]) && path[2].parse::<usize>().is_ok() => strip_entry(value),
        4 | 5 if FAMILIES.contains(&path[1]) && path[2].parse::<usize>().is_ok() && path[3] == "keys" => {
            if path.len() == 4 {
                if let Some(keys) = value.as_array_mut() {
                    for map in keys.iter_mut().filter_map(Json::as_object_mut) {
                        strip_auth_index(map);
                    }
                }
            } else if path[4].parse::<usize>().is_ok()
                && let Some(map) = value.as_object_mut()
            {
                strip_auth_index(map);
            }
        }
        _ => {}
    }
}
