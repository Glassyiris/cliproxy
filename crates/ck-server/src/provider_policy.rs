//! Provider scope and order (cooker only, see docs/DIFFERENCES-FROM-GO.md): the
//! `providers` blocks of `routing` and of `model-routers` entries. `exclude` takes
//! credentials out of a request's scope; `order` ranks the rest in tiers, tried top down,
//! with `routing.strategy` balancing inside a tier. Order only decides unbound picks: a
//! session bound to a credential stays on it while that credential is in scope.
//!
//! A selector names an `api-keys` entry (`provider-a`, an OpenAI-compatibility entry
//! too), every login file of a type (`kimi`), or one login file by its `auth-dir` path
//! without `.json` or its account (`kimi/<file>`, `kimi/<email>`), case-insensitively.

use std::collections::HashMap;
use std::sync::Arc;

use ck_core::config::Config;
use ck_core::credential::{Credential, Source};
use ck_wire::gostr::GoStr;
use serde_yaml_ng::Value;

#[derive(Debug, Default)]
pub struct Providers {
    exclude: Vec<String>,
    /// Tiers, highest first; each lists its selectors.
    order: Vec<Vec<String>>,
    /// Config credential ID → its `api-keys` entry name.
    names: Arc<HashMap<String, String>>,
}

/// `exclude` and `order` of a `providers` block, and the selectors `order` lists twice
/// (their first tier applies).
fn parse(v: &Value) -> (Vec<String>, Vec<Vec<String>>, Vec<String>) {
    let words = |v: &Value| -> Vec<String> {
        let one = std::slice::from_ref(v);
        let list = match v {
            Value::Sequence(list) => list.as_slice(),
            Value::Null => &[],
            _ => one,
        };
        list.iter()
            .filter_map(|s| s.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned))
            .collect()
    };
    let (mut seen, mut repeated): (Vec<String>, Vec<String>) = Default::default();
    let mut order = Vec::new();
    for item in v["order"].as_sequence().into_iter().flatten() {
        let mut tier = words(item);
        tier.retain(|s| {
            if seen.iter().any(|o| o.go_eq_fold(s)) {
                repeated.push(s.clone());
                return false;
            }
            seen.push(s.clone());
            true
        });
        if !tier.is_empty() {
            order.push(tier);
        }
    }
    (words(&v["exclude"]), order, repeated)
}

fn login(c: &Credential) -> bool {
    !matches!(c.source, Source::Config { .. })
}

impl Providers {
    /// Whether this block excludes or orders anything; an empty one leaves Go's behaviour.
    pub fn is_set(&self) -> bool {
        !self.exclude.is_empty() || !self.order.is_empty()
    }

    /// `routing.providers`.
    pub fn global(cfg: &Config) -> Self {
        let (exclude, order, _) = parse(&cfg.document["routing"]["providers"]);
        Self {
            exclude,
            order,
            names: Arc::new(ck_core::config::credentials::entry_names(cfg)),
        }
    }

    /// A router's `providers` block over these: both exclusions apply, and the router's
    /// order, when it has one, replaces this one.
    pub(crate) fn within(&self, v: &Value) -> Self {
        let (exclude, order, _) = parse(v);
        Self {
            exclude: self.exclude.iter().chain(&exclude).cloned().collect(),
            order: if order.is_empty() { self.order.clone() } else { order },
            names: self.names.clone(),
        }
    }

    fn matches(&self, selector: &str, c: &Credential) -> bool {
        match selector.split_once('/') {
            None => {
                self.names.get(&c.id).is_some_and(|n| n.go_eq_fold(selector))
                    || (login(c) && c.provider.go_eq_fold(selector))
            }
            Some((kind, rest)) => {
                login(c)
                    && c.provider.go_eq_fold(kind)
                    && (c.id.strip_suffix(".json").unwrap_or(&c.id).go_eq_fold(rest)
                        || c.id.go_eq_fold(rest)
                        || c.label.go_eq_fold(rest))
            }
        }
    }

    pub fn excludes(&self, c: &Credential) -> bool {
        self.exclude.iter().any(|s| self.matches(s, c))
    }

    /// [`Self::excludes`] for a request that names `model` itself: a model named with the
    /// credential's prefix (`provider-a/model`) still reaches it.
    pub fn excludes_direct(&self, c: &Credential, model: &str) -> bool {
        self.excludes(c) && crate::registry::strip_prefix(model, c).len() == model.len()
    }

    /// Whether `c` is outside a request's scope: its router's (`scope`), else `global`
    /// (`routing.providers`) for a request that names `model`.
    pub fn out_of_scope(scope: Option<&Self>, global: &Self, c: &Credential, model: &str) -> bool {
        match scope {
            Some(scope) => scope.excludes(c),
            None => global.excludes_direct(c, model),
        }
    }

    /// The credential's tier: higher ranks first. Listed tiers outrank every unlisted
    /// credential, which keeps its `priority` (all of them without an order, as in Go).
    pub fn rank(&self, c: &Credential) -> (bool, i64) {
        match self
            .order
            .iter()
            .position(|tier| tier.iter().any(|s| self.matches(s, c)))
        {
            Some(i) => (true, -(i as i64)),
            None => (false, crate::scheduler::priority(c)),
        }
    }

    /// The selector that names `c`: its `api-keys` entry, else `type/file` for a login.
    pub fn name(&self, c: &Credential) -> String {
        match self.names.get(&c.id) {
            Some(name) => name.clone(),
            None if login(c) => format!("{}/{}", c.provider, c.id.strip_suffix(".json").unwrap_or(&c.id)),
            None => c.provider.clone(),
        }
    }

    /// What is wrong with the config's `providers` blocks given `creds`: selectors that
    /// match no credential, and selectors an `order` lists twice. Logged on publish.
    pub(crate) fn problems<C: std::borrow::Borrow<Credential>>(cfg: &Config, creds: &[C]) -> Vec<String> {
        let global = Self::global(cfg);
        let routers = cfg.document["model-routers"].as_sequence().into_iter().flatten();
        let blocks = std::iter::once(("routing.providers".to_owned(), &cfg.document["routing"]["providers"])).chain(
            routers.map(|r| {
                let name = r["name"].as_str().unwrap_or_default().trim();
                (format!("model-routers {name:?} providers"), &r["providers"])
            }),
        );
        let mut out = Vec::new();
        for (at, block) in blocks {
            let (exclude, order, repeated) = parse(block);
            for s in repeated {
                out.push(format!("{at}: {s:?} is listed twice in order; its first tier applies"));
            }
            for s in exclude.iter().chain(order.iter().flatten()) {
                let known = global.names.values().any(|n| n.go_eq_fold(s))
                    || creds.iter().any(|c| login(c.borrow()) && global.matches(s, c.borrow()));
                if !known {
                    out.push(format!("{at}: {s:?} matches no credential"));
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login_file(id: &str, provider: &str, label: &str) -> Credential {
        Credential {
            id: id.into(),
            provider: provider.into(),
            source: Source::File(id.into()),
            disabled: false,
            label: label.into(),
            attributes: Default::default(),
            metadata: Default::default(),
            revision: 0,
        }
    }

    #[test]
    fn selectors_tiers_and_names() {
        let yaml = "routing:\n  providers:\n    exclude: [Provider-X]\n    order:\n      - [kimi/kimi-1, provider-a]\n      - opencode-zen\n      - kimi\n      - provider-a\napi-keys:\n  claude:\n    - name: provider-a\n      priority: 9\n      keys: [{api-key: a}]\n    - name: provider-x\n      prefix: px\n      keys: [{api-key: x}]\n    - keys: [{api-key: unnamed}]\n  openai-compatibility:\n    - name: opencode-zen\n      base-url: https://zen.example.invalid/v1\n      keys: [{api-key: z}]\n";
        let cfg = Config::parse(yaml).unwrap();
        let p = Providers::global(&cfg);
        let config = ck_core::config::credentials::from_config(&cfg);
        let by_key = |key: &str| {
            config
                .iter()
                .find(|c| c.attributes.get("api_key").map(String::as_str) == Some(key))
                .unwrap()
        };
        let (a, x, unnamed, zen) = (by_key("a"), by_key("x"), by_key("unnamed"), by_key("z"));
        let kimi1 = login_file("kimi-1.json", "kimi", "me@example.com");
        let kimi2 = login_file("kimi-2.json", "kimi", "you@example.com");
        // Entry names, case-insensitively; a login type matches only login files.
        assert!(p.excludes(x) && !p.excludes(a));
        // A request that names the excluded entry's prefix still reaches it.
        assert!(p.excludes_direct(x, "model") && !p.excludes_direct(x, "px/model"));
        assert_eq!(p.rank(&kimi1), (true, 0), "a file selector in the first tier");
        assert_eq!(p.rank(a), (true, 0), "listed twice: the first tier applies");
        assert_eq!(p.rank(zen), (true, -1));
        assert_eq!(p.rank(&kimi2), (true, -2));
        // Unlisted credentials rank below every tier and keep their priority.
        assert_eq!(p.rank(unnamed), (false, 0));
        assert!(p.rank(unnamed) < p.rank(&kimi2));
        // An account selector, and a router that keeps the global exclusions.
        let mine = p.within(&serde_yaml_ng::from_str("{exclude: [kimi/ME@example.com]}").unwrap());
        assert!(mine.excludes(&kimi1) && mine.excludes(x) && !mine.excludes(&kimi2));
        assert_eq!(mine.rank(&kimi1), (true, 0), "no order of its own: the global one");
        assert_eq!(
            (
                p.name(a).as_str(),
                p.name(zen).as_str(),
                p.name(&kimi1).as_str(),
                p.name(unnamed).as_str()
            ),
            ("provider-a", "opencode-zen", "kimi/kimi-1", "claude")
        );
    }
}
