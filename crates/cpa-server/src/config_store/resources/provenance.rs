use serde_json::Value as Json;

use super::{Kind, PROVENANCE, Resource, at_path, document};

pub fn preserve_scope(current: &[Resource], next: &mut Vec<Resource>) {
    let before = document(current, false);
    let after = document(next, false);
    next.retain_mut(|r| {
        r.kind != Kind::Setting
            || r.id != PROVENANCE
            || retain_scope(r, &before, &after, |value, stored| value == stored)
    });
}

pub(super) fn retain_scope(
    resource: &mut Resource,
    before: &Json,
    after: &Json,
    same: fn(Option<&Json>, Option<&Json>) -> bool,
) -> bool {
    let Some(paths) = resource.spec.get_mut("global-oauth-paths").and_then(Json::as_array_mut) else {
        return false;
    };
    paths.retain(|path| {
        path.as_str().is_some_and(|path| {
            let parts: Vec<_> = path.split('.').collect();
            let value = at_path(after, &parts);
            value.is_some() && same(value, at_path(before, &parts))
        })
    });
    !paths.is_empty()
}
