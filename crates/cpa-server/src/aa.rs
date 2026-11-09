//! Artificial Analysis benchmarks for the model routers (cook-router only, see
//! docs/DIFFERENCES-FROM-GO.md): each model's intelligence index, the cost of running
//! the index's benchmark tasks, and its list prices. Fetched with the configured
//! `artificial-analysis.api-key`, kept in memory (and in `cache-file` when set) and
//! fetched again once a day; a failed fetch keeps the last data and retries in an hour.
//! Source: Artificial Analysis free API (https://artificialanalysis.ai/); its terms
//! require attribution.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::Runtime;

pub const DEFAULT_URL: &str = "https://artificialanalysis.ai/api/v2/language/models/free";
/// AA asks clients to cache; a free key allows 1,000 requests a day.
const TTL: Duration = Duration::from_secs(24 * 3600);
const RETRY: Duration = Duration::from_secs(3600);
const PAGE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PAGES: usize = 50;
const MAX_PAGE_SIZE: usize = 8 << 20;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Model {
    pub name: String,
    pub model_creator: Option<Creator>,
    pub evaluations: Option<Evaluations>,
    pub artificial_analysis_intelligence_index_cost: Option<IndexCost>,
    pub pricing: Option<Pricing>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Creator {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Evaluations {
    pub artificial_analysis_intelligence_index: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct IndexCost {
    pub cost_per_task: Option<TaskCost>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TaskCost {
    pub total_cost: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Pricing {
    pub price_1m_input_tokens: Option<f64>,
    pub price_1m_output_tokens: Option<f64>,
}

/// One measured variant: a model at one effort, as AA names it ("GPT-6.1 Sol (High)").
#[derive(Debug, Clone, PartialEq)]
pub struct Measured {
    /// The effort label: `high`, `max`, `off` (AA's "Non-reasoning"); `None` unlabeled.
    pub level: Option<String>,
    pub index: f64,
    /// USD per AA benchmark task, reasoning tokens included.
    pub task_cost: f64,
    /// AA's 3:1 blended list price per million tokens; 0 when unknown.
    pub blended_price: f64,
}

/// The catalog file layout (`{fetchedAt, data}`, `fetchedAt` in Unix milliseconds).
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    fetched_at: u64,
    data: Vec<Model>,
}

/// Measured variants by normalized model name.
#[derive(Default)]
pub struct Catalog {
    fetched_at: u64,
    by_name: HashMap<String, Vec<Measured>>,
}

/// AA's 3:1 blend of input and output prices.
pub fn blend(input: f64, output: f64) -> f64 {
    (3.0 * input + output) / 4.0
}

/// Lower-cased ASCII letters and digits only: "Claude Opus 5.5" and `claude-opus-5-5`
/// both become `claudeopus55`.
pub fn norm(s: &str) -> String {
    s.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// The name without its trailing `(…)` and the effort label inside: "GPT-6.1 Sol (High)"
/// is `("GPT-6.1 Sol", Some("high"))`, "Claude Opus 5.5 (Max, Default Fallback)" `max`,
/// "X (Non-reasoning)" `off`.
fn split_level(name: &str) -> (&str, Option<String>) {
    let trimmed = name.trim_end();
    let Some(open) = trimmed.strip_suffix(')').and_then(|s| s.rfind('(')) else {
        return (trimmed, None);
    };
    let inner = &trimmed[open + 1..trimmed.len() - 1];
    let mut label = inner.split(',').next().unwrap_or_default().trim().to_ascii_lowercase();
    if let Some(rest) = label.strip_suffix("with fallback") {
        label = rest.trim().to_owned();
    }
    let label = if label == "non-reasoning" {
        "off".to_owned()
    } else {
        label
    };
    (trimmed[..open].trim_end(), Some(label).filter(|l| !l.is_empty()))
}

impl Catalog {
    pub(crate) fn new(fetched_at: u64, models: &[Model]) -> Self {
        let mut by_name: HashMap<String, Vec<Measured>> = HashMap::new();
        for m in models {
            let index = m
                .evaluations
                .as_ref()
                .and_then(|e| e.artificial_analysis_intelligence_index);
            let task_cost = m
                .artificial_analysis_intelligence_index_cost
                .as_ref()
                .and_then(|c| c.cost_per_task.as_ref())
                .and_then(|c| c.total_cost);
            let (Some(index), Some(task_cost)) = (index, task_cost) else {
                continue;
            };
            let (base, level) = split_level(&m.name);
            let price = m.pricing.as_ref();
            let measured = Measured {
                level,
                index,
                task_cost,
                blended_price: blend(
                    price.and_then(|p| p.price_1m_input_tokens).unwrap_or(0.0),
                    price.and_then(|p| p.price_1m_output_tokens).unwrap_or(0.0),
                ),
            };
            // "Kimi K3" by Kimi also answers to `K3`.
            let base = norm(base);
            let creator = norm(
                m.model_creator
                    .as_ref()
                    .and_then(|c| c.name.as_deref())
                    .unwrap_or_default(),
            );
            if let Some(short) = base
                .strip_prefix(creator.as_str())
                .filter(|s| !creator.is_empty() && !s.is_empty())
            {
                by_name.entry(short.to_owned()).or_default().push(measured.clone());
            }
            by_name.entry(base).or_default().push(measured);
        }
        Self { fetched_at, by_name }
    }

    /// Every measured effort of the model named `name` (a display name or ID).
    pub fn variants(&self, name: &str) -> &[Measured] {
        self.by_name.get(&norm(name)).map(Vec::as_slice).unwrap_or_default()
    }

    fn age(&self) -> Duration {
        Duration::from_millis(now_ms().saturating_sub(self.fetched_at))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Every page of the AA model list.
async fn fetch(url: &str, key: &str) -> Result<Vec<Model>, String> {
    #[derive(Deserialize)]
    struct Page {
        data: Vec<Model>,
        #[serde(default)]
        pagination: Option<Pagination>,
    }
    #[derive(Deserialize)]
    struct Pagination {
        #[serde(default)]
        has_more: bool,
    }
    let client = cpa_exec::proxy::default_client();
    let separator = if url.contains('?') { '&' } else { '?' };
    let mut out = Vec::new();
    for page in 1..=MAX_PAGES {
        let mut headers = cpa_exec::proxy::GoHeaders::new();
        headers.set("x-api-key", key);
        let target = format!("{url}{separator}page={page}");
        let response = cpa_exec::proxy::request(&client, wreq::Method::GET, &target, headers, None, Some(PAGE_TIMEOUT))
            .await
            .map_err(|_| "request failed".to_owned())?;
        if response.status != 200 {
            return Err(format!("HTTP {}", response.status));
        }
        let body = cpa_exec::proxy::read_all(response.body, MAX_PAGE_SIZE, false)
            .await
            .map_err(|_| "body read failed".to_owned())?;
        let page: Page = serde_json::from_slice(&body).map_err(|_| "unexpected response".to_owned())?;
        out.extend(page.data.into_iter().filter(|m| !m.name.is_empty()));
        if !page.pagination.is_some_and(|p| p.has_more) {
            break;
        }
    }
    // An empty list would replace good data with nothing to rank.
    if out.is_empty() {
        return Err("empty model list".to_owned());
    }
    Ok(out)
}

fn read_file(path: &Path) -> Option<File> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Replaces `path` atomically, so a reader never sees half a file.
fn write_file(path: &Path, file: &File) -> std::io::Result<()> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let partial = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&partial, serde_json::to_vec(file)?)?;
    std::fs::rename(&partial, path)
}

/// Keeps `rt`'s catalog current for its lifetime: loads `cache-file` once, fetches when
/// the data is a day old, an hour after a failure, and looks again on every config
/// change. Without an API key nothing is fetched. A test runtime never reaches the
/// default URL. Call once per runtime.
pub fn start(rt: &Arc<Runtime>) {
    let weak: Weak<Runtime> = Arc::downgrade(rt);
    let mut changes = rt.subscribe_config();
    tokio::spawn(async move {
        let mut loaded_file = None;
        loop {
            let wait = {
                let Some(rt) = weak.upgrade() else { return };
                let settings = crate::model_router::settings(&rt.config()).aa.clone();
                if settings.cache_file != loaded_file {
                    loaded_file.clone_from(&settings.cache_file);
                    if let Some(file) = settings.cache_file.as_deref().and_then(read_file) {
                        let fresher = rt.model_router.catalog().is_none_or(|c| c.fetched_at < file.fetched_at);
                        if fresher {
                            rt.model_router.publish(Catalog::new(file.fetched_at, &file.data));
                        }
                    }
                }
                let age = rt.model_router.catalog().map(|c| c.age());
                let deny = rt.deny_external.load(std::sync::atomic::Ordering::Relaxed) && settings.url == DEFAULT_URL;
                match age {
                    _ if settings.key.is_empty() || deny => None,
                    Some(age) if age < TTL => Some(TTL - age),
                    _ => {
                        drop(rt);
                        let fetched = fetch(&settings.url, &settings.key).await;
                        let Some(rt) = weak.upgrade() else { return };
                        match fetched {
                            Ok(data) => {
                                let file = File {
                                    fetched_at: now_ms(),
                                    data,
                                };
                                tracing::info!("Artificial Analysis: {} models fetched", file.data.len());
                                rt.model_router.publish(Catalog::new(file.fetched_at, &file.data));
                                if let Some(path) = settings.cache_file.as_deref()
                                    && let Err(e) = write_file(path, &file)
                                {
                                    tracing::warn!("Artificial Analysis cache not written: {e}");
                                }
                                Some(TTL)
                            }
                            Err(reason) => {
                                tracing::warn!("Artificial Analysis fetch failed ({reason}); keeping the last data");
                                Some(RETRY)
                            }
                        }
                    }
                }
            };
            let changed = match wait {
                Some(wait) => tokio::select! {
                    () = tokio::time::sleep(wait) => Ok(()),
                    changed = changes.changed() => changed,
                },
                None => changes.changed().await,
            };
            if changed.is_err() {
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(name: &str, creator: &str, index: f64, cost: f64) -> Model {
        Model {
            name: name.into(),
            model_creator: Some(Creator {
                name: Some(creator.into()),
            }),
            evaluations: Some(Evaluations {
                artificial_analysis_intelligence_index: Some(index),
            }),
            artificial_analysis_intelligence_index_cost: Some(IndexCost {
                cost_per_task: Some(TaskCost { total_cost: Some(cost) }),
            }),
            pricing: Some(Pricing {
                price_1m_input_tokens: Some(1.0),
                price_1m_output_tokens: Some(5.0),
            }),
        }
    }

    #[test]
    fn names_and_effort_labels() {
        let catalog = Catalog::new(
            0,
            &[
                model("GPT-6.1 Sol (High)", "OpenAI", 70.0, 1.0),
                model("Claude Opus 5.5 (Max, Default Fallback)", "Anthropic", 75.0, 3.0),
                model("Grok 5 (Non-reasoning)", "xAI", 40.0, 0.2),
                model("Kimi K3", "Kimi", 60.0, 0.5),
            ],
        );
        let level = |name: &str| catalog.variants(name)[0].level.clone();
        assert_eq!(level("gpt-6.1-sol").as_deref(), Some("high"));
        assert_eq!(level("claude-opus-5-5").as_deref(), Some("max"));
        assert_eq!(level("Grok 5").as_deref(), Some("off"));
        assert_eq!(level("K3"), None, "the creator prefix is optional");
        assert_eq!(level("kimi-k3"), None);
        assert_eq!(catalog.variants("K3")[0].blended_price, 2.0);
        assert!(catalog.variants("missing").is_empty());
    }

    #[tokio::test]
    async fn fetch_reads_every_page_with_the_key() {
        use axum::extract::Query;
        use axum::http::HeaderMap;
        async fn page(Query(q): Query<HashMap<String, String>>, headers: HeaderMap) -> axum::response::Response {
            use axum::response::IntoResponse;
            if headers.get("x-api-key").and_then(|v| v.to_str().ok()) != Some("aa-key") {
                return axum::http::StatusCode::UNAUTHORIZED.into_response();
            }
            let body = match q.get("page").map(String::as_str) {
                Some("1") => r#"{"data":[{"name":"A (High)"}],"pagination":{"has_more":true}}"#,
                _ => r#"{"data":[{"name":"B"},{"nameless":1}],"pagination":{"has_more":false}}"#,
            };
            ([("content-type", "application/json")], body).into_response()
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/models", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, axum::Router::new().route("/models", axum::routing::get(page))).await
        });
        let names: Vec<String> = fetch(&url, "aa-key")
            .await
            .unwrap()
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert_eq!(names, ["A (High)", "B"]);
        assert_eq!(fetch(&url, "wrong").await.unwrap_err(), "HTTP 401");
    }
}
