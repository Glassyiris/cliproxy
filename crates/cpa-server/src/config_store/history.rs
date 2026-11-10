use super::*;

impl ConfigStore {
    /// The state the store held after `rev`, with secrets hidden (history keeps no
    /// secrets): [`Self::replace`] restores it with the current secrets.
    pub fn state_at(&self, rev: u64) -> anyhow::Result<Vec<Resource>> {
        let conn = self.conn();
        anyhow::ensure!(rev >= 1 && rev <= head(&conn)?, "no revision {rev}");
        let mut stmt = conn.prepare(
            "SELECT kind, id, after FROM change c
             WHERE rev = (SELECT max(rev) FROM change WHERE kind = c.kind AND id = c.id AND rev <= ?1)
             AND after IS NOT NULL",
        )?;
        let rows = stmt.query_map([rev as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })?;
        let mut out = Vec::new();
        let mut bytes = 0usize;
        for row in rows {
            anyhow::ensure!(out.len() < resources::MAX_RESOURCES, "revision exceeds resource limit");
            let (kind, id, after) = row?;
            bytes = bytes.saturating_add(after.len());
            anyhow::ensure!(bytes <= resources::MAX_STATE_BYTES, "revision exceeds state size limit");
            let kind = stored_kind(&kind)?;
            let stored: Stored = serde_json::from_str(&after)?;
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
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT rev, at, actor, message, digest FROM revision WHERE rev < ?1 ORDER BY rev DESC LIMIT ?2",
        )?;
        let before = before.map_or(i64::MAX, |b| i64::try_from(b).unwrap_or(i64::MAX));
        let limit = limit.min(500);
        let rows = stmt.query_map(params![before, limit], |r| {
            Ok(Revision {
                rev: r.get::<_, i64>(0)? as u64,
                at: r.get(1)?,
                actor: r.get(2)?,
                message: r.get(3)?,
                digest: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// One revision and what it changed.
    pub fn revision(&self, rev: u64) -> anyhow::Result<Option<(Revision, Vec<Change>)>> {
        let conn = self.conn();
        let found = conn
            .query_row(
                "SELECT rev, at, actor, message, digest FROM revision WHERE rev = ?1",
                [rev as i64],
                |r| {
                    Ok(Revision {
                        rev: r.get::<_, i64>(0)? as u64,
                        at: r.get(1)?,
                        actor: r.get(2)?,
                        message: r.get(3)?,
                        digest: r.get(4)?,
                    })
                },
            )
            .optional()?;
        let Some(revision) = found else { return Ok(None) };
        let mut stmt = conn.prepare("SELECT kind, id, before, after FROM change WHERE rev = ?1 ORDER BY kind, id")?;
        let rows = stmt.query_map([rev as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut changes = Vec::new();
        let mut bytes = 0usize;
        for row in rows {
            let (kind, id, before, after) = row?;
            bytes = bytes
                .saturating_add(before.as_ref().map_or(0, String::len))
                .saturating_add(after.as_ref().map_or(0, String::len));
            anyhow::ensure!(
                bytes <= resources::MAX_STATE_BYTES * 2 && changes.len() < resources::MAX_RESOURCES * 2,
                "revision exceeds state size limit"
            );
            let kind = stored_kind(&kind)?;
            let parse = |t: Option<String>| -> anyhow::Result<Option<Json>> {
                t.map(|text| {
                    let stored: Stored = serde_json::from_str(&text)?;
                    let mut r = Resource::new(kind, &id, stored.ord, stored.spec);
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
            let before = parse(before)?;
            let after = parse(after)?;
            changes.push(Change {
                kind,
                id,
                before,
                after,
            });
        }
        Ok(Some((revision, changes)))
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
