use super::*;

impl ConfigStore {
    /// The state the store held after `rev`, with secrets hidden (history keeps no
    /// secrets): [`Self::replace`] restores it with the current secrets.
    pub fn state_at(&self, rev: u64) -> anyhow::Result<Vec<Resource>> {
        let state = self.current();
        anyhow::ensure!(rev >= 1 && rev <= state.rev(), "no revision {rev}");
        let mut latest = std::collections::BTreeMap::new();
        for (_, changes) in state.changes.range(..=rev) {
            for change in changes.iter() {
                latest.insert((change.kind, &change.id), change.after.as_ref());
            }
        }
        let mut out = Vec::new();
        let mut bytes = 0usize;
        for ((kind, id), after) in latest {
            let Some(after) = after else { continue };
            anyhow::ensure!(out.len() < resources::MAX_RESOURCES, "revision exceeds resource limit");
            bytes = bytes.saturating_add(after.len());
            anyhow::ensure!(bytes <= resources::MAX_STATE_BYTES, "revision exceeds state size limit");
            let stored: Stored = serde_json::from_str(after)?;
            let mut r = Resource::new(kind, id, stored.ord, stored.spec);
            r.description = stored.description;
            out.push(resources::redacted(&r));
        }
        out.sort_by(|a, b| (a.kind, a.ord, &a.id).cmp(&(b.kind, b.ord, &b.id)));
        Ok(out)
    }

    /// Revisions, newest first: at most `limit`, older than `before` when given.
    // ponytail: revision history grows with operator writes; add pruning when storage warrants it.
    pub fn revisions(&self, limit: u32, before: Option<u64>) -> anyhow::Result<Vec<Revision>> {
        let state = self.current();
        let before = before.unwrap_or(i64::MAX as u64).min(i64::MAX as u64);
        Ok(state
            .revisions
            .range(..before)
            .rev()
            .take(limit.min(500) as usize)
            .map(|(_, revision)| revision.as_ref().clone())
            .collect())
    }

    /// One revision and what it changed.
    pub fn revision(&self, rev: u64) -> anyhow::Result<Option<(Revision, Vec<Change>)>> {
        let state = self.current();
        let Some(revision) = state.revisions.get(&rev) else {
            return Ok(None);
        };
        let mut changes = Vec::new();
        let mut bytes = 0usize;
        for change in state.changes.get(&rev).into_iter().flat_map(|changes| changes.iter()) {
            let state::HistoryChange {
                kind,
                id,
                before,
                after,
            } = change;
            let kind = *kind;
            bytes = bytes
                .saturating_add(before.as_ref().map_or(0, String::len))
                .saturating_add(after.as_ref().map_or(0, String::len));
            anyhow::ensure!(
                bytes <= resources::MAX_STATE_BYTES * 2 && changes.len() < resources::MAX_RESOURCES * 2,
                "revision exceeds state size limit"
            );
            let parse = |t: Option<String>| -> anyhow::Result<Option<Json>> {
                t.map(|text| {
                    let stored: Stored = serde_json::from_str(&text)?;
                    let mut r = Resource::new(kind, id, stored.ord, stored.spec);
                    r.description = stored.description;
                    let r = resources::redacted(&r);
                    Ok(serde_json::to_value(Stored {
                        ord: r.ord,
                        description: r.description,
                        spec: r.spec,
                    })?)
                })
                .transpose()
            };
            let before = parse(before.clone())?;
            let after = parse(after.clone())?;
            changes.push(Change {
                kind,
                id: id.clone(),
                before,
                after,
            });
        }
        Ok(Some((revision.as_ref().clone(), changes)))
    }
}

/// What history stores of a resource.
#[derive(Serialize, Deserialize)]
struct Stored {
    ord: i64,
    #[serde(default)]
    description: String,
    spec: Json,
}

pub(super) fn shown_change(before: Option<&Resource>, after: Option<&Resource>) -> Change {
    let side = |r: Option<&Resource>| {
        r.map(|r| {
            let r = resources::redacted(r);
            serde_json::to_value(Stored {
                ord: r.ord,
                description: r.description,
                spec: r.spec,
            })
            .expect("JSON")
        })
    };
    let r = after.or(before).expect("a change has a side");
    Change {
        kind: r.kind,
        id: r.id.clone(),
        before: side(before),
        after: side(after),
    }
}
