use super::*;

impl ConfigStore {
    /// Replaces everything with the resources of the config file `text`.
    pub fn import_yaml(&self, text: &str, actor: &str, message: &str) -> Result<Committed, CommitError> {
        let resources = resources::import_yaml(text)
            .map_err(|e| CommitError::new(422, "invalid_config", None, format!("{e:#}")))?;
        self.replace(resources, actor, message, false)
    }

    /// Makes the store hold exactly `resources`. A [`resources::SECRET`] keeps the
    /// value the same resource holds now.
    pub fn replace(
        &self,
        resources: Vec<Resource>,
        actor: &str,
        message: &str,
        dry_run: bool,
    ) -> Result<Committed, CommitError> {
        self.replace_if(resources, actor, message, dry_run, None)
    }

    pub fn replace_if(
        &self,
        resources: Vec<Resource>,
        actor: &str,
        message: &str,
        dry_run: bool,
        condition: Option<Precondition>,
    ) -> Result<Committed, CommitError> {
        self.transact(actor, message, dry_run, condition, |current| {
            if resources.len() > resources::MAX_RESOURCES {
                return Err(CommitError::invalid("too many resources"));
            }
            let mut next = resources;
            for r in &mut next {
                let stored = current.iter().find(|c| c.kind == r.kind && c.id == r.id);
                resources::resolve_secrets(r, stored).map_err(fault_422)?;
                resources::hash_management_key(r).map_err(fault_422)?;
                if let Some(stored) = stored {
                    r.created_rev = stored.created_rev;
                    r.rev = stored.rev;
                }
            }
            Ok(next)
        })
    }

    pub fn commit_if(
        &self,
        ops: &[Op],
        actor: &str,
        message: &str,
        dry_run: bool,
        condition: Option<Precondition>,
    ) -> Result<Committed, CommitError> {
        if ops.len() > 1000 {
            return Err(CommitError::invalid("too many operations (maximum 1000)"));
        }
        let mut operation_bytes = 0usize;
        for op in ops {
            let value = serde_json::to_value(op).map_err(CommitError::db)?;
            operation_bytes = operation_bytes.saturating_add(value.to_string().len());
            if operation_bytes > resources::MAX_STATE_BYTES {
                return Err(CommitError::invalid("operations exceed total size limit"));
            }
            if !resources::bounded(&value) || value.to_string().len() > resources::MAX_SPEC_BYTES {
                return Err(CommitError::invalid("operation exceeds size or depth limit"));
            }
        }
        self.transact(actor, message, dry_run, condition, |current| {
            let mut next = current.to_vec();
            for op in ops {
                apply(&mut next, op)?;
            }
            Ok(next)
        })
    }

    /// Lets `edit` change the annotated document (`"@id"` on each provider and router
    /// entry), then stores the resources it splits into, as one revision.
    pub fn edit(
        &self,
        actor: &str,
        message: &str,
        edit: impl FnOnce(&mut Json) -> Result<(), CommitError>,
    ) -> Result<Committed, CommitError> {
        self.transact(actor, message, false, None, |current| {
            let mut doc = resources::document(current, true);
            edit(&mut doc)?;
            from_document(&doc, current)
        })
    }

    /// The write path every config commit takes: under the owner gate, `edit`
    /// derives the next resources from accepted memory; validated differences
    /// become one revision in the complete candidate image.
    fn transact(
        &self,
        actor: &str,
        message: &str,
        dry_run: bool,
        condition: Option<Precondition>,
        edit: impl FnOnce(&[Resource]) -> Result<Vec<Resource>, CommitError>,
    ) -> Result<Committed, CommitError> {
        if actor.len() > 256 || message.len() > 4096 {
            return Err(CommitError::invalid("actor or message exceeds size limit"));
        }
        let mut pending = self.writer().map_err(CommitError::db)?;
        let accepted = self.current();
        let current = accepted.resources.as_ref();
        let rev = accepted.rev();
        let matches = match &condition {
            None => true,
            Some(Precondition::Revision(want)) => rev == *want,
            Some(Precondition::AnyRevision(wants)) => wants.len() <= 1000 && wants.contains(&rev),
            Some(Precondition::Exists) => rev != 0,
        };
        if !matches {
            return Err(CommitError::new(
                412,
                "precondition_failed",
                None,
                "config changed since it was read",
            ));
        }
        if current.len() > resources::MAX_RESOURCES {
            return Err(CommitError::invalid("too many resources"));
        }
        let next = edit(current)?;
        if next.len() > resources::MAX_RESOURCES {
            return Err(CommitError::invalid("too many resources"));
        }
        let mut seen = std::collections::HashSet::new();
        for r in &next {
            resources::check(r).map_err(fault_422)?;
            if !seen.insert((r.kind, r.id.as_str())) {
                return Err(CommitError::new(
                    422,
                    "invalid_config",
                    Some(r.key()),
                    "the same resource twice",
                ));
            }
        }
        let (config, text) = resources::config(&next).map_err(|f| fault_422(culprit(current, &next, f)))?;
        let digest = public_digest(&next);
        let changes = diff(current, &next);
        let shown: Vec<Change> = changes.iter().map(|(b, a)| shown_change(*b, *a)).collect();
        if changes.is_empty() && rev != 0 || dry_run {
            if !dry_run {
                // A retry can match an already committed write whose publication
                // failed. It still needs a durable snapshot before success.
                self.publish(&accepted).map_err(CommitError::db)?;
            }
            return Ok(Committed {
                rev,
                written: false,
                changes: shown,
                config,
                digest,
                text,
                resources: next,
            });
        }
        let rev = rev + 1;
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut resources = next;
        for r in &mut resources {
            if !current
                .iter()
                .any(|c| c.kind == r.kind && c.id == r.id && c.same_content(r))
            {
                r.rev = rev;
                if r.created_rev == 0 {
                    r.created_rev = rev;
                }
            }
        }
        resources.sort_by(|a, b| (a.kind, a.ord, &a.id).cmp(&(b.kind, b.ord, &b.id)));
        let mut candidate = accepted.as_ref().clone();
        candidate.resources = Arc::new(resources.clone());
        candidate.revisions.insert(
            rev,
            Arc::new(Revision {
                rev,
                at,
                actor: actor.to_owned(),
                message: message.to_owned(),
                digest: digest.clone(),
            }),
        );
        let mut history: Vec<_> = shown
            .iter()
            .map(|change| state::HistoryChange {
                kind: change.kind,
                id: change.id.clone(),
                before: change.before.as_ref().map(Json::to_string),
                after: change.after.as_ref().map(Json::to_string),
            })
            .collect();
        history.sort_by(|a, b| (a.kind.name(), &a.id).cmp(&(b.kind.name(), &b.id)));
        candidate.changes.insert(rev, Arc::new(history));
        self.accept(candidate, &mut pending).map_err(CommitError::db)?;
        Ok(Committed {
            rev,
            written: true,
            changes: shown,
            config,
            digest,
            text,
            resources,
        })
    }
}

/// The resources that differ between `current` and `next`, as (before, after).
fn diff<'a>(current: &'a [Resource], next: &'a [Resource]) -> Vec<(Option<&'a Resource>, Option<&'a Resource>)> {
    let find = |set: &'a [Resource], r: &Resource| set.iter().find(|o| o.kind == r.kind && o.id == r.id);
    let mut out: Vec<_> = next
        .iter()
        .filter_map(|n| match find(current, n) {
            Some(c) if c.same_content(n) => None,
            c => Some((c, Some(n))),
        })
        .collect();
    out.extend(
        current
            .iter()
            .filter(|c| find(next, c).is_none())
            .map(|c| (Some(c), None)),
    );
    out
}

fn kind_of(name: &str) -> Result<Kind, CommitError> {
    Kind::parse(name).ok_or_else(|| CommitError::new(404, "unknown_kind", None, format!("no resource kind {name:?}")))
}

fn expect_rev(existing: Option<&Resource>, key: &str, if_rev: Option<u64>, if_absent: bool) -> Result<(), CommitError> {
    let stale = || {
        CommitError::new(
            412,
            "precondition_failed",
            Some(key.to_owned()),
            "changed since it was read",
        )
    };
    match (existing, if_rev, if_absent) {
        (Some(_), _, true) => Err(stale()),
        (Some(r), Some(want), _) if r.rev != want => Err(stale()),
        (None, Some(_), _) => Err(stale()),
        _ => Ok(()),
    }
}

/// RFC 7396 merge patch.
fn merge_patch(target: &mut Json, patch: &Json) {
    let Json::Object(patch) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Json::Object(serde_json::Map::new());
    }
    let map = target.as_object_mut().expect("object");
    for (key, value) in patch {
        if value.is_null() {
            map.remove(key);
        } else {
            merge_patch(map.entry(key.clone()).or_insert(Json::Null), value);
        }
    }
}

fn empty_like(v: &Json) -> bool {
    match v {
        Json::Null => true,
        Json::Array(a) => a.is_empty(),
        Json::Object(o) => o.is_empty(),
        _ => false,
    }
}

/// Applies one operation to `next`, the resources so far in this commit.
fn apply(next: &mut Vec<Resource>, op: &Op) -> Result<(), CommitError> {
    let position = |next: &[Resource], kind: Kind, id: &str| next.iter().position(|r| r.kind == kind && r.id == id);
    match op {
        Op::Put { kind, spec, .. } | Op::Patch { kind, patch: spec, .. }
            if kind == "plugin" && spec.get(resources::RAW_YAML).is_some() =>
        {
            return Err(CommitError::new(
                400,
                "read_only_field",
                None,
                "reserved config metadata",
            ));
        }
        _ => {}
    }
    match op {
        Op::Check { kind, id, revisions } => {
            let kind = kind_of(kind)?;
            let existing = position(next, kind, id).map(|i| &next[i]);
            if !existing.is_some_and(|r| {
                revisions
                    .as_ref()
                    .is_none_or(|revs| revs.len() <= 1000 && revs.contains(&r.rev))
            }) {
                return Err(CommitError::new(
                    412,
                    "precondition_failed",
                    Some(format!("{}/{id}", kind.name())),
                    "resource changed since it was read",
                ));
            }
        }
        Op::Put {
            kind,
            id,
            spec,
            ord,
            description,
            if_rev,
            if_absent,
        } => {
            let kind = kind_of(kind)?;
            let at = position(next, kind, id);
            let existing = at.map(|i| &next[i]);
            let key = format!("{}/{id}", kind.name());
            expect_rev(existing, &key, *if_rev, *if_absent)?;
            let group = spec
                .get("type")
                .and_then(Json::as_str)
                .filter(|_| kind == Kind::Provider)
                .unwrap_or_default();
            let last = next
                .iter()
                .filter(|r| r.kind == kind && r.group() == group)
                .map(|r| r.ord.saturating_add(1))
                .max()
                .unwrap_or(0);
            let mut r = Resource::new(kind, id.clone(), 0, spec.clone());
            r.ord = match (kind.ordered(), ord, existing) {
                (false, _, _) => 0,
                (true, Some(o), _) => *o,
                (true, None, Some(e)) => e.ord,
                (true, None, None) => last,
            };
            r.description = description
                .clone()
                .or_else(|| existing.map(|e| e.description.clone()))
                .unwrap_or_default();
            if let Some(e) = existing {
                r.rev = e.rev;
                r.created_rev = e.created_rev;
            }
            resources::resolve_secrets(&mut r, existing).map_err(fault_422)?;
            resources::hash_management_key(&mut r).map_err(fault_422)?;
            match at {
                Some(i) => next[i] = r,
                None => next.push(r),
            }
        }
        Op::Patch {
            kind,
            id,
            patch,
            if_rev,
        } => {
            let kind = kind_of(kind)?;
            let key = format!("{}/{id}", kind.name());
            let i = position(next, kind, id)
                .ok_or_else(|| CommitError::new(404, "not_found", Some(key.clone()), "no such resource"))?;
            expect_rev(Some(&next[i]), &key, *if_rev, false)?;
            let stored = next[i].clone();
            let mut r = if kind == Kind::Plugin {
                stored.clone()
            } else {
                resources::redacted(&stored)
            };
            if kind == Kind::Plugin {
                resources::patch_plugin_controls(&mut r, patch).map_err(fault_422)?;
            } else {
                merge_patch(&mut r.spec, patch);
            }
            resources::resolve_secrets(&mut r, Some(&stored)).map_err(fault_422)?;
            resources::hash_management_key(&mut r).map_err(fault_422)?;
            next[i] = r;
        }
        Op::Delete { kind, id, if_rev } => {
            let kind = kind_of(kind)?;
            let key = format!("{}/{id}", kind.name());
            let i = position(next, kind, id)
                .ok_or_else(|| CommitError::new(404, "not_found", Some(key.clone()), "no such resource"))?;
            expect_rev(Some(&next[i]), &key, *if_rev, false)?;
            next.remove(i);
        }
        Op::Move {
            kind,
            id,
            before,
            after,
            if_rev,
        } => {
            let kind = kind_of(kind)?;
            let key = format!("{}/{id}", kind.name());
            if !kind.ordered() {
                return Err(CommitError::new(
                    400,
                    "unordered_kind",
                    Some(key),
                    "only list entries have an order",
                ));
            }
            let i = position(next, kind, id)
                .ok_or_else(|| CommitError::new(404, "not_found", Some(key.clone()), "no such resource"))?;
            expect_rev(Some(&next[i]), &key, *if_rev, false)?;
            let mut order: Vec<String> = {
                let group = next[i].group().to_owned();
                let mut of_kind: Vec<&Resource> =
                    next.iter().filter(|r| r.kind == kind && r.group() == group).collect();
                of_kind.sort_by_key(|r| r.ord);
                of_kind
                    .into_iter()
                    .map(|r| r.id.clone())
                    .filter(|other| other != id)
                    .collect()
            };
            let anchor = |target: &String| {
                order.iter().position(|o| o == target).ok_or_else(|| {
                    CommitError::new(
                        404,
                        "not_found",
                        Some(format!("{}/{target}", kind.name())),
                        "no such resource",
                    )
                })
            };
            let slot = match (before, after) {
                (Some(b), None) => anchor(b)?,
                (None, Some(a)) => anchor(a)? + 1,
                (None, None) => order.len(),
                (Some(_), Some(_)) => {
                    return Err(CommitError::new(
                        400,
                        "invalid_move",
                        Some(key),
                        "give before or after, not both",
                    ));
                }
            };
            order.insert(slot, id.clone());
            for (n, entry) in order.iter().enumerate() {
                if let Some(j) = position(next, kind, entry) {
                    next[j].ord = n as i64;
                }
            }
        }
        Op::Set { path, value, expect } => set_at(next, path, Some(value.clone()), expect.as_ref())?,
        Op::Unset { path, expect } => set_at(next, path, None, expect.as_ref())?,
    }
    Ok(())
}

/// A [`Op::Set`] or [`Op::Unset`]: edits the annotated document, then splits it back
/// into resources that keep their identity.
fn set_at(next: &mut Vec<Resource>, path: &str, value: Option<Json>, expect: Option<&Json>) -> Result<(), CommitError> {
    if path.len() > 4096 || path.split('/').count() > resources::MAX_DEPTH {
        return Err(CommitError::invalid("path exceeds size or depth limit"));
    }
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if let Some(expect) = expect {
        let shown = resources::document_for_read(next);
        let now = resources::at_path(&shown, &parts)
            .cloned()
            .map(|value| resources::strip_read_annotations_at(value, &parts));
        let expect = resources::strip_read_annotations_at(expect.clone(), &parts);
        let same = match now {
            Some(v) => v == expect || empty_like(&v) && empty_like(&expect),
            None => empty_like(&expect),
        };
        if !same {
            return Err(CommitError::new(
                412,
                "precondition_failed",
                None,
                format!("{path} changed since it was read"),
            )
            .at(path));
        }
    }
    let mut doc = resources::document_for_read(next);
    resources::set_path(&mut doc, &parts, value)
        .map_err(|e| CommitError::new(400, "invalid_path", None, e).at(path))?;
    *next = from_document(&doc, next)?;
    Ok(())
}

/// `doc` split into resources that keep the identity they have in `current`, with
/// each [`resources::SECRET`] resolved and a plaintext management key hashed.
fn from_document(doc: &Json, current: &[Resource]) -> Result<Vec<Resource>, CommitError> {
    let mut split = resources::split(doc, current).map_err(fault_422)?;
    for r in &mut split {
        let stored = current.iter().find(|s| s.kind == r.kind && s.id == r.id);
        resources::resolve_secrets(r, stored).map_err(fault_422)?;
        resources::hash_management_key(r).map_err(fault_422)?;
    }
    Ok(split)
}
