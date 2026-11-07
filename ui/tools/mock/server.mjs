#!/usr/bin/env node
// Mock v8 Management API for the dashboard. Zero dependencies, deterministic for a seed.
//
//   node server.mjs [--port 0] [--accounts 1000] [--seed 1] [--key mock]
//
// Response shapes follow crates/cpa-server/src/management/*.rs. State lives in memory: write routes
// answer like the real server and change what the next read returns. GET /credentials changes about
// 5% of the accounts per call (request counts, last-used bucket) so the dashboard sees live traffic;
// every other account serialises to identical bytes. Unknown routes answer Go's empty 404.
import http from "node:http";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    host: { type: "string", default: "127.0.0.1" },
    accounts: { type: "string", default: "1000" },
    seed: { type: "string", default: "1" },
    key: { type: "string", default: "mock" },
    churn: { type: "string", default: "0.05" },
    quiet: { type: "boolean", default: false },
  },
});
const N = Math.max(0, Number(opt.accounts));
const CHURN = Number(opt.churn);
const KEY = opt.key;
const VERSION = "cliproxy-rs-mock";
const BUCKET_MS = 600_000;

// ---------------------------------------------------------------------------------------------
// Deterministic PRNG (mulberry32). All generation and churn draw from it, in request order.
function prng(seed) {
  let a = Number(seed) >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return next;
}
const rand = prng(opt.seed);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
const chance = (p) => rand() < p;

const startedAt = Date.now();
const iso = (t) => new Date(t).toISOString();

// ---------------------------------------------------------------------------------------------
// Accounts
const PROVIDERS = [
  ["claude", 0.28, "Claude"],
  ["codex", 0.26, "Codex"],
  ["gemini", 0.12, "Gemini"],
  ["kimi", 0.1, "Kimi"],
  ["antigravity", 0.1, "Antigravity"],
  ["xai", 0.07, "xAI"],
  ["devin", 0.04, "Devin"],
  ["vertex", 0.03, "Vertex"],
];
const FIRST = ["ada", "bo", "cyra", "dai", "eli", "fen", "gus", "hana", "ivo", "jun", "kai", "lia", "mo", "nia", "oz", "pia", "quin", "rex", "sol", "tai", "uma", "vik", "wen", "xin", "yu", "zed"];
const LAST = ["stone", "river", "field", "brook", "hill", "wood", "lake", "ridge", "vale", "marsh", "crest", "glen"];
const MODELS = {
  claude: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  codex: ["gpt-5-codex", "gpt-5", "gpt-5-mini"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  kimi: ["kimi-k2", "kimi-k2-thinking"],
  antigravity: ["gemini-3-pro-high", "claude-sonnet-4-5-thinking"],
  xai: ["grok-4", "grok-code-fast-1"],
  devin: ["devin-swe-1"],
  vertex: ["gemini-2.5-pro"],
};

/** Server-relative bucket clock: bucket 0 starts at the 10-minute boundary before server start. */
const bucketOrigin = Math.floor(startedAt / BUCKET_MS) * BUCKET_MS;
let bucketIndex = 0;
const clock = (t) => new Date(t).toTimeString().slice(0, 5);
const bucketLabel = (back) => {
  const s = bucketOrigin + (bucketIndex - back) * BUCKET_MS;
  return `${clock(s)}-${clock(s + BUCKET_MS)}`;
};

function weighted() {
  let r = rand();
  for (const p of PROVIDERS) if ((r -= p[1]) < 0) return p[0];
  return PROVIDERS[0][0];
}

function makeAccount(i) {
  const provider = weighted();
  const email = `${pick(FIRST)}.${pick(LAST)}${i}@example.invalid`;
  const name = `${provider}-${email}.json`;
  const a = {
    id: name,
    auth_index: hex(16),
    name,
    type: provider,
    provider,
    label: "",
    status: "active",
    status_message: "",
    disabled: false,
    unavailable: false,
    runtime_only: false,
    source: "file",
    size: int(1800, 3600),
    // Not serialised: counts per ten-minute bucket, oldest first.
    _b: Array.from({ length: 20 }, () => [0, 0]),
    success: 0,
    failed: 0,
    quota: { signals: {} },
    email,
    account_type: "oauth",
    account: email,
    created_at: iso(startedAt - int(1, 90) * 86_400_000),
    updated_at: iso(startedAt - int(1, 300) * 3_600_000),
    modtime: iso(startedAt - int(1, 300) * 3_600_000),
    last_refresh: iso(startedAt - int(1, 48) * 3_600_000),
    path: `/var/lib/cliproxy/auth/${name}`,
    cooldowns: [],
  };
  if (provider === "codex") {
    a.id_token = { chatgpt_account_id: `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`, plan_type: pick(["plus", "plus", "pro", "team"]) };
  }
  if (provider === "vertex") a.project_id = `mock-project-${int(1, 40)}`;
  if (chance(0.1)) a.priority = int(1, 10);
  if (chance(0.1)) a.note = pick(["shared", "team seat", "personal", "backup", "do not rotate"]);
  if (chance(0.05)) a.weight = int(1, 5);
  if (chance(0.03)) a.request_retry = int(0, 4);

  // Traffic: about half the accounts served something in the last 200 minutes.
  if (chance(0.55)) {
    const level = int(1, 40);
    for (const b of a._b) {
      if (!chance(0.6)) continue;
      b[0] = int(0, level);
      b[1] = chance(0.12) ? int(1, 3) : 0;
    }
  }
  if (chance(0.15)) a._b[19][0] += int(1, 6);
  const sums = a._b.reduce((s, b) => [s[0] + b[0], s[1] + b[1]], [0, 0]);
  a.success = sums[0] + int(0, 5000);
  a.failed = sums[1] + int(0, 80);

  // State: disabled, cooling, signed out, model-scope cooldown, or ready.
  const r = rand();
  if (r < 0.05) {
    a.disabled = true;
    a.status = "disabled";
    if (chance(0.5)) a.status_message = "disabled via management API";
  } else if (r < 0.1) {
    const at = startedAt + int(1, 6) * 3_600_000;
    const cd = { scope: "credential", reason: pick(["quota", "transient_error"]), retry_at: iso(at), remaining_seconds: Math.round((at - startedAt) / 1000) };
    if (cd.reason === "quota") (cd.backoff_level = int(0, 3)), (cd.http_status = 429);
    else cd.http_status = pick([500, 502, 503]);
    if ((provider === "claude" || provider === "codex") && chance(0.5)) cd.recover_at = iso(at + int(1, 5) * 3_600_000);
    a.cooldowns.push(cd);
    a.status = "error";
    a.unavailable = true;
    a.next_retry_after = cd.retry_at;
  } else if (r < 0.12) {
    a.status = "error";
    a.unavailable = true;
    a.status_message = "unauthorized (refresh token invalid)";
  } else if (r < 0.15) {
    const at = startedAt + int(1, 4) * 3_600_000;
    a.cooldowns.push({
      scope: "model",
      model_key: pick(MODELS[provider] || ["model"]),
      reason: "quota",
      retry_at: iso(at),
      remaining_seconds: Math.round((at - startedAt) / 1000),
      backoff_level: 1,
      http_status: 429,
    });
  }

  // Passive quota windows, as read from response headers.
  if ((provider === "codex" || provider === "claude" || provider === "devin") && !a.disabled && chance(0.75)) {
    const s = {};
    const used = () => (chance(0.12) ? int(86, 99) : int(1, 80));
    if (provider === "codex") {
      for (const [w, minutes] of [["primary", 300], ["secondary", 10080]]) {
        s[`x-codex-${w}-used-percent`] = String(used());
        s[`x-codex-${w}-window-minutes`] = String(minutes);
        s[`x-codex-${w}-reset-after-seconds`] = String(int(600, minutes * 60));
        s[`x-codex-${w}-reset-at`] = String(Math.floor(startedAt / 1000) + int(600, minutes * 60));
      }
    } else if (provider === "claude") {
      for (const [w, span] of [["5h", 18_000], ["7d", 604_800]]) {
        s[`anthropic-ratelimit-unified-${w}-utilization`] = (used() / 100).toFixed(2);
        s[`anthropic-ratelimit-unified-${w}-reset`] = String(Math.floor(startedAt / 1000) + int(600, span));
      }
    } else {
      s.daily_quota_remaining_percent = String(int(5, 100));
      s.daily_quota_reset_at = iso(startedAt + int(1, 20) * 3_600_000);
      s.weekly_quota_remaining_percent = String(int(5, 100));
      s.weekly_quota_reset_at = iso(startedAt + int(1, 6) * 86_400_000);
    }
    a.quota = { observed_at: iso(startedAt - int(1, 30) * 60_000), signals: s };
  }
  return a;
}

const accounts = [];
for (let i = 0; i < N; i++) accounts.push(makeAccount(i));
accounts.sort((x, y) => (x.name.toLowerCase() < y.name.toLowerCase() ? -1 : x.name.toLowerCase() > y.name.toLowerCase() ? 1 : 0));

/** The wire form of one account, cached until the account changes. */
function wire(a) {
  if (a._json) return a._json;
  const { _b, _json, ...rest } = a;
  const out = { ...rest };
  out.recent_requests = _b.map(([s, f], i) => ({ time: bucketLabel(19 - i), success: s, failed: f }));
  // The real list is key-sorted (Go map ordering).
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return (a._json = JSON.stringify(sorted));
}

/** Move every bucket window when the server-relative clock crosses a ten-minute boundary. */
function slideBuckets() {
  const idx = Math.floor((Date.now() - bucketOrigin) / BUCKET_MS);
  while (bucketIndex < idx) {
    bucketIndex++;
    for (const a of accounts) {
      a._b.shift();
      a._b.push([0, 0]);
      a._json = null;
    }
  }
}

/** Live traffic: about CHURN of the accounts that can serve receive requests. */
function churn() {
  const live = accounts.filter((a) => !a.disabled && !a.unavailable);
  const k = Math.min(live.length, Math.max(live.length ? 1 : 0, Math.round(accounts.length * CHURN)));
  const seen = new Set();
  while (seen.size < k) {
    const a = live[Math.floor(rand() * live.length)];
    if (seen.has(a)) continue;
    seen.add(a);
    const ok = int(1, 4);
    const bad = chance(0.1) ? 1 : 0;
    a._b[19][0] += ok;
    a._b[19][1] += bad;
    a.success += ok;
    a.failed += bad;
    a._json = null;
  }
}

const find = (name, index) =>
  accounts.find((a) => (name ? a.name === name || a.id === name : true) && (index ? a.auth_index === index : true) && (name || index));

// ---------------------------------------------------------------------------------------------
// Configuration (kebab-case, as GET /config returns it)
const apiKey = () => `sk-${hex(48)}`;
let configVersion = 1;
const config = {
  "config-version": 8,
  server: { host: "", port: 8317, tls: { enable: false } },
  management: { "allow-remote": false, "secret-key": "$2a$10$mockmockmockmockmockmu", "disable-auto-update-panel": false },
  access: { "api-keys": [apiKey(), apiKey()] },
  routing: { strategy: "soonest-reset", retry: { "request-retry": 3, "max-retry-interval": 30 }, "session-affinity": true },
  requests: {
    "proxy-url": "",
    payload: {
      default: [{ models: [{ name: "gemini-*", protocol: "gemini" }], params: { "generationConfig.thinkingConfig.thinkingBudget": 32768 } }],
      "default-raw": [],
      override: [{ models: [{ name: "gpt-5*" }], params: { "reasoning.effort": "high" } }],
      "override-raw": [],
      filter: [],
    },
  },
  "api-keys": {
    claude: [{ name: "team", keys: [{ "api-key": `sk-ant-${hex(32)}` }] }],
    codex: [{ name: "relay", "base-url": "https://relay.example.invalid/v1", keys: [{ "api-key": `sk-${hex(32)}` }] }],
    gemini: [{ name: "studio", keys: [{ "api-key": `AIza${hex(35)}` }] }],
    vertex: [],
    "openai-compatibility": [{ name: "openrouter", "base-url": "https://openrouter.example.invalid/api/v1", keys: [{ "api-key": `sk-or-${hex(32)}` }] }],
    interactions: [],
    xai: [],
    meta: [],
  },
  oauth: {
    "auth-dir": "~/.cli-proxy-api",
    "model-alias": { claude: [{ name: "claude-sonnet-4-5", alias: "sonnet" }], codex: [] },
    "excluded-models": { claude: ["claude-3-*"], codex: [] },
  },
  client: {},
  multimedia: {},
  observability: { logs: { "logging-to-file": true }, usage: { enabled: true } },
  plugins: { enabled: true, dir: "plugins", configs: { "quota-demo": { enabled: true }, "idle-demo": { enabled: false } } },
};
let yamlText = null;

const walk = (parts) => parts.reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), config);
function setPath(parts, value, merge) {
  let o = config;
  for (const k of parts.slice(0, -1)) o = o[k] && typeof o[k] === "object" ? o[k] : (o[k] = {});
  const last = parts[parts.length - 1];
  if (merge && o[last] && typeof o[last] === "object" && value && typeof value === "object" && !Array.isArray(value)) Object.assign(o[last], value);
  else o[last] = value;
}
function delPath(parts) {
  const parent = parts.length > 1 ? walk(parts.slice(0, -1)) : config;
  if (!parent || typeof parent !== "object" || !(parts[parts.length - 1] in parent)) return false;
  delete parent[parts[parts.length - 1]];
  return true;
}
function toYaml(v, pad = "") {
  const scalar = (x) => (typeof x === "string" ? (/^[\w./~@-][\w ./~@:-]*$/.test(x) && !/^(true|false|null|\d.*)$/i.test(x) ? x : JSON.stringify(x)) : String(x));
  if (Array.isArray(v)) return v.length ? v.map((x) => (x && typeof x === "object" ? `${pad}-\n${toYaml(x, pad + "  ")}` : `${pad}- ${scalar(x)}`)).join("\n") : `${pad}[]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) return `${pad}{}`;
    return keys
      .map((k) => {
        const x = v[k];
        if (x && typeof x === "object" && Object.keys(x).length) return `${pad}${k}:\n${toYaml(x, pad + "  ")}`;
        return `${pad}${k}: ${x && typeof x === "object" ? (Array.isArray(x) ? "[]" : "{}") : scalar(x)}`;
      })
      .join("\n");
  }
  return `${pad}${scalar(v)}`;
}

// ---------------------------------------------------------------------------------------------
// Logs, plugins, OAuth sessions, usage
const logs = [];
const LOG_MESSAGES = [
  ["info", "GIN", "200 | 1.2ms | 127.0.0.1 | GET /v8/management/credentials"],
  ["info", "", "request: POST /v1/messages model=claude-sonnet-4-5 auth=%A"],
  ["info", "", "response: 200 OK in 2.3s tokens in=812 out=1204"],
  ["warn", "", "credential %A cooling after upstream 429, retry in 30m"],
  ["error", "", "upstream error 502 from api.anthropic.com, retrying on next credential"],
  ["debug", "", "scheduler picked %A strategy=soonest-reset"],
];
function logLine() {
  const [lvl, , msg] = pick(LOG_MESSAGES);
  const t = new Date().toISOString().replace("T", " ").slice(0, 19);
  const id = lvl === "debug" ? "--------" : hex(8);
  const a = accounts.length ? pick(accounts).auth_index : "none";
  return `[${t}] [${id}] [${lvl.padEnd(5)}] [handler.go:${int(40, 900)}] ${msg.replace("%A", a)}`;
}
for (let i = 0; i < 400; i++) logs.push(logLine());
const errorLogs = [
  { name: `error-v1-messages-2026-11-08T03-12-44-${hex(8)}.log`, size: 4231, modified: Math.floor(startedAt / 1000) - 3600 },
  { name: `error-v1-responses-2026-11-07T21-40-02-${hex(8)}.log`, size: 9120, modified: Math.floor(startedAt / 1000) - 36000 },
];

const plugins = [
  { id: "quota-demo", name: "Quota Demo", version: "1.2.0", registered: true, enabled: true, oauth: false, quota: true },
  { id: "oauth-demo", name: "OAuth Demo", version: "0.9.1", registered: true, enabled: true, oauth: true, quota: false },
  { id: "idle-demo", name: "Idle Demo", version: "0.1.0", registered: false, enabled: false, oauth: false, quota: false },
];
const pluginView = (p) => ({
  id: p.id,
  path: `plugins/${p.id}`,
  configured: true,
  registered: p.registered,
  enabled: p.enabled,
  effective_enabled: config.plugins.enabled && p.enabled && p.registered,
  supports_oauth: p.oauth,
  oauth_provider: p.oauth ? "demo-oauth" : "",
  supports_quota: p.quota,
  ...(p.quota ? { quota_provider: "demo" } : {}),
  logo: "",
  config_fields: [],
  menus: [],
  metadata: { name: p.name, version: p.version, author: "Mock", github_repository: "", logo: "", config_fields: [] },
});
const storeCatalog = [
  { id: "quota-demo", name: "Quota Demo", description: "Reads provider quota windows.", version: "1.2.0" },
  { id: "log-shipper", name: "Log Shipper", description: "Ships request logs to an HTTP endpoint.", version: "0.4.0" },
  { id: "model-lab", name: "Model Lab", description: "Extra model definitions.", version: "2.0.3" },
];
const sessions = new Map();

/** Per-provider usage payloads a quota check parses (src/core.ts quotaWindows). */
function usagePayload(url, a) {
  const used = () => int(3, 95);
  const reset = (h) => iso(Date.now() + h * 3_600_000);
  if (url.includes("anthropic.com"))
    return { five_hour: { utilization: used(), resets_at: reset(3) }, seven_day: { utilization: used(), resets_at: reset(90) } };
  if (url.includes("chatgpt.com"))
    return {
      rate_limit: {
        primary_window: { used_percent: used(), limit_window_seconds: 18000, reset_after_seconds: 7200 },
        secondary_window: { used_percent: used(), limit_window_seconds: 604800, reset_after_seconds: 300000 },
      },
    };
  if (url.includes("kimi"))
    return { usages: { "5h_window": { used: used(), limit: 100, reset_time: reset(2) }, weekly: { used: used(), limit: 100, reset_time: reset(80) } } };
  return {};
}

// ---------------------------------------------------------------------------------------------
// HTTP
const routes = [];
const on = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
const fail = (status, error, extra) => ({ status, body: { error, ...extra } });
const ok = (body = { status: "ok" }, status = 200) => ({ status, body });
const text = (status, body, type = "text/plain; charset=utf-8", headers = {}) => ({ status, raw: body, type, headers });

function obj(ctx) {
  try {
    const v = JSON.parse(ctx.body.toString("utf8") || "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
const str = (v) => (typeof v === "string" ? v.trim() : "");

// Config
const configPath = (ctx) => decodeURIComponent(ctx.m[1] || "").split("/").filter(Boolean);
const etag = () => `"mock-${configVersion}"`;
on("GET", "/config", () => ({ status: 200, body: config, headers: { ETag: etag(), "Cache-Control": "no-store" } }));
on("GET", "/config/(.*)", (ctx) => {
  const v = walk(configPath(ctx));
  return v === undefined ? fail(404, "not_found") : { status: 200, body: v, headers: { ETag: etag(), "Cache-Control": "no-store" } };
});
for (const method of ["PUT", "PATCH"]) {
  on(method, "/config(?:/(.*))?", (ctx) => {
    const parts = ctx.m[1] ? configPath(ctx) : [];
    let value;
    try {
      value = JSON.parse(ctx.body.toString("utf8"));
    } catch {
      return fail(400, "invalid_json");
    }
    if (!parts.length) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return fail(400, "config_must_be_object");
      for (const k of Object.keys(config)) if (method === "PUT") delete config[k];
      Object.assign(config, value);
    } else setPath(parts, value, method === "PATCH");
    configVersion++;
    yamlText = null;
    return { status: 200, body: { "config-version": 8, status: "ok" }, headers: { ETag: etag() } };
  });
}
on("DELETE", "/config/(.*)", (ctx) => {
  const parts = configPath(ctx);
  if (!parts.length) return fail(400, "cannot_delete_config");
  if (!delPath(parts)) return fail(404, "not_found");
  configVersion++;
  yamlText = null;
  return { status: 200, body: { "config-version": 8, status: "ok" }, headers: { ETag: etag() } };
});
on("GET", "/config\\.yaml", () => text(200, yamlText ?? toYaml(config) + "\n", "application/yaml; charset=utf-8", { ETag: etag(), "Cache-Control": "no-store" }));
on("PUT", "/config\\.yaml", (ctx) => {
  // The mock keeps the text; it does not parse YAML back into the JSON view.
  const t = ctx.body.toString("utf8");
  if (!t.trim()) return fail(400, "invalid_body");
  yamlText = t;
  configVersion++;
  return { status: 200, body: { "config-version": 8, status: "ok" }, headers: { ETag: etag() } };
});

// Credentials
on("GET", "/credentials", (ctx) => {
  slideBuckets();
  churn();
  const name = str(ctx.q.get("name")),
    index = str(ctx.q.get("auth_index"));
  let list = accounts.filter((a) => (!name || a.name === name || a.id === name) && (!index || a.auth_index === index));
  const page = Number(ctx.q.get("page")),
    size = Number(ctx.q.get("page_size"));
  const observed = `"observed_at":${JSON.stringify(iso(Date.now()))}`;
  if (ctx.q.has("page") || ctx.q.has("page_size")) {
    if ((ctx.q.has("page") && !(page > 0)) || (ctx.q.has("page_size") && !(size > 0))) return fail(400, `${ctx.q.has("page") && !(page > 0) ? "page" : "page_size"} must be a positive integer`);
    const p = page || 1,
      s = size || 50;
    const start = Math.min((p - 1) * s, list.length),
      end = Math.min(start + s, list.length);
    return { status: 200, raw: `{${observed},"files":[${list.slice(start, end).map(wire).join(",")}],"total":${list.length},"page":${p},"page_size":${s},"has_more":${end < list.length}}`, type: "json" };
  }
  return { status: 200, raw: `{${observed},"files":[${list.map(wire).join(",")}]}`, type: "json" };
});
on("POST", "/credentials", (ctx) => {
  const type = ctx.req.headers["content-type"] || "";
  if (!type.startsWith("multipart/form-data")) return fail(400, "invalid multipart form");
  const raw = ctx.body.toString("utf8");
  const parts = [...raw.matchAll(/filename="([^"]+)"\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*?)\r\n--/g)];
  if (!parts.length) return fail(400, "no files uploaded");
  const uploaded = [],
    failed = [];
  for (const [, file, content] of parts) {
    if (!file.endsWith(".json")) {
      failed.push({ name: file, error: "file must end with .json" });
      continue;
    }
    let meta = {};
    try {
      meta = JSON.parse(content);
    } catch {
      failed.push({ name: file, error: "invalid JSON" });
      continue;
    }
    const a = makeAccount(accounts.length);
    a.name = a.id = file;
    a.path = `/var/lib/cliproxy/auth/${file}`;
    if (typeof meta.type === "string") a.type = a.provider = meta.type;
    if (typeof meta.email === "string") a.email = a.account = meta.email;
    accounts.push(a);
    uploaded.push(file);
  }
  accounts.sort((x, y) => (x.name.toLowerCase() < y.name.toLowerCase() ? -1 : 1));
  return failed.length ? { status: 207, body: { status: "partial", uploaded: uploaded.length, files: uploaded, failed } } : ok({ status: "ok", uploaded: uploaded.length, files: uploaded });
});
on("DELETE", "/credentials", (ctx) => {
  const body = obj(ctx);
  const names = ctx.q.get("name") ? [ctx.q.get("name")] : Array.isArray(body?.names) ? body.names.map(str).filter(Boolean) : [];
  if (!names.length) return fail(400, "invalid request body");
  let deleted = 0;
  for (const n of names) {
    const i = accounts.findIndex((a) => a.name === n);
    if (i < 0) return deleted ? ok({ status: "partial", deleted }) : fail(404, "file not found");
    accounts.splice(i, 1);
    deleted++;
  }
  return ok({ status: "ok", deleted });
});
on("GET", "/credentials/models", (ctx) => {
  const name = ctx.q.get("name");
  if (!name) return fail(400, "name is required");
  const a = find(name);
  return ok({ models: a ? (MODELS[a.provider] || []).map((id) => ({ id, object: "model", created: 0, owned_by: a.provider, type: a.provider })) : [] });
});
on("GET", "/credentials/download", (ctx) => {
  const name = str(ctx.q.get("name"));
  if (!name || /[\\/]/.test(name)) return fail(400, "invalid name");
  if (!name.endsWith(".json")) return fail(400, "name must end with .json");
  const a = find(name);
  if (!a) return fail(404, "file not found");
  const body = JSON.stringify({ type: a.provider, email: a.email, access_token: "mock-access-token", refresh_token: "mock-refresh-token", expired: iso(Date.now() + 3_600_000) });
  return text(200, body, "application/json", { "Content-Disposition": `attachment; filename="${name}"` });
});
on("PATCH", "/credentials/status", (ctx) => {
  const b = obj(ctx);
  if (!b || typeof b.disabled !== "boolean" || !str(b.name)) return fail(400, "invalid request body");
  const a = find(str(b.name), str(b.auth_index));
  if (!a) return fail(404, "auth file not found");
  a.disabled = b.disabled;
  a.status = b.disabled ? "disabled" : "active";
  a.status_message = b.disabled ? "disabled via management API" : "";
  a._json = null;
  return ok({ status: "ok", disabled: a.disabled });
});
on("PATCH", "/credentials/fields", (ctx) => {
  const b = obj(ctx);
  const name = str(b?.name);
  if (!name) return fail(400, "name is required");
  const keys = ["note", "priority", "weight", "request_retry"].filter((k) => k in b);
  if (!keys.length) return fail(400, "no fields to update");
  const a = find(name);
  if (!a) return fail(404, "auth file not found");
  for (const k of keys) {
    if (b[k] === null || b[k] === "") delete a[k];
    else a[k] = b[k];
  }
  a._json = null;
  return ok();
});
on("POST", "/credentials/refresh", (ctx) => {
  const b = obj(ctx);
  if (b?.all === true) return ok({ ok: true, results: accounts.map((a) => ({ id: a.id, success: true })) });
  const name = str(b?.name);
  if (!name) return fail(400, "name or all=true is required");
  const a = find(name, str(b.auth_index));
  if (!a) return fail(404, "auth file not found");
  a.last_refresh = iso(Date.now());
  a._json = null;
  return ok({ ok: true, auth: JSON.parse(wire(a)) });
});
on("POST", "/routing/cooldown/reset", (ctx) => {
  const b = obj(ctx);
  if (!b) return fail(400, "invalid request body");
  const index = str(b.auth_index);
  if (!index) return fail(400, "auth_index is required");
  const a = find("", index);
  if (!a) return fail(404, "auth file not found");
  a.cooldowns = [];
  if (a.status === "error" && !/unauthorized/.test(a.status_message)) (a.status = "active"), (a.unavailable = false), delete a.next_retry_after;
  a._json = null;
  return ok({ status: "ok", auth_index: index });
});
on("GET", "/routing/model-definitions/([^/]+)", (ctx) => {
  const channel = decodeURIComponent(ctx.m[1]).trim().toLowerCase();
  const ids = MODELS[channel];
  if (!ids) return fail(400, "unknown channel", { channel });
  return ok({
    channel,
    models: ids.map((id) => ({ id, object: "model", created: 1_750_000_000, owned_by: channel, type: channel, display_name: id.replace(/-/g, " "), context_length: 200_000, max_completion_tokens: 64_000 })),
  });
});

// Requests
on("POST", "/requests/api-call", (ctx) => {
  const b = obj(ctx);
  if (!b || !str(b.url) || !str(b.method)) return fail(400, "invalid request body");
  const a = find("", str(b.authIndex ?? b.auth_index));
  if (str(b.authIndex ?? b.auth_index) && !a) return fail(404, "auth not found");
  return { status: 200, body: { status_code: 200, header: { "Content-Type": ["application/json"] }, body: JSON.stringify(usagePayload(str(b.url), a)) } };
});
on("GET", "/server/latest-version", () => ok({ "latest-version": "v0.0.0-mock" }));

// Usage
on("GET", "/observability/usage/api-keys", () => {
  const entries = (items) =>
    Object.fromEntries(
      items.map((k) => [
        k,
        { success: 120, failed: 3, recent_requests: Array.from({ length: 20 }, (_, i) => ({ time: bucketLabel(19 - i), success: (i * 7) % 11, failed: i % 9 === 0 ? 1 : 0 })) },
      ]),
    );
  const body = {};
  for (const [family, groups] of Object.entries(config["api-keys"] || {})) {
    for (const g of groups) {
      const provider = family === "openai-compatibility" ? String(g.name || "").toLowerCase() : family;
      body[provider] = { ...(body[provider] || {}), ...entries((g.keys || []).map((k) => `${g["base-url"] || ""}|${k["api-key"]}`)) };
    }
  }
  return ok(body);
});
on("GET", "/observability/usage/queue", (ctx) => {
  const raw = str(ctx.q.get("count"));
  const count = raw ? Number(raw) : 1;
  if (!Number.isInteger(count) || count <= 0) return fail(400, "count must be a positive integer");
  const out = [];
  for (let i = 0; i < Math.min(count, int(0, 3)); i++) {
    const a = accounts.length ? pick(accounts) : null;
    const failed = chance(0.08);
    out.push({
      timestamp: iso(Date.now()),
      request_id: hex(8),
      provider: a?.provider || "claude",
      auth_index: a?.auth_index || "",
      model: pick(MODELS[a?.provider] || ["claude-sonnet-4-5"]),
      latency_ms: int(300, 9000),
      ttft_ms: int(80, 1500),
      failed,
      ...(failed ? { fail: { status_code: 502 } } : {}),
      tokens: { input_tokens: int(200, 4000), output_tokens: int(50, 2000) },
    });
  }
  return ok(out);
});

// OAuth
on("GET", "/oauth/auth-url", (ctx) => {
  const provider = str(ctx.q.get("provider")).toLowerCase();
  if (!provider) return fail(400, "provider is required");
  if (!MODELS[provider] && !plugins.some((p) => p.oauth && "demo-oauth" === provider)) return fail(400, "unsupported provider", { code: "provider_not_found" });
  const state = hex(16);
  sessions.set(state, { provider, at: Date.now(), cancelled: false });
  return ok({ status: "ok", url: `https://auth.example.invalid/authorize?state=${state}`, state });
});
on("GET", "/oauth/status", (ctx) => {
  const s = sessions.get(str(ctx.q.get("state")));
  if (!s) return ok({ status: "error", error: "unknown or expired state" });
  return ok(s.cancelled ? { status: "error", error: "cancelled" } : { status: "wait" });
});
on("DELETE", "/oauth/session", (ctx) => {
  const s = sessions.get(str(ctx.q.get("state")));
  if (s) s.cancelled = true;
  return ok({ status: "ok", cancelled: !!s });
});
on("POST", "/oauth/callback", () => ok());
on("POST", "/oauth/import", (ctx) => {
  if (str(ctx.q.get("provider")) !== "vertex") return fail(400, "unsupported provider");
  return fail(400, "no file uploaded");
});

// Logs
on("GET", "/observability/logs", (ctx) => {
  if (chance(0.5)) logs.push(logLine());
  if (chance(0.3)) logs.push(logLine());
  const limit = Number(ctx.q.get("limit") || 0);
  if (ctx.q.has("limit") && !(limit > 0)) return fail(400, "invalid limit: must be a positive integer");
  const cursor = str(ctx.q.get("cursor"));
  const at = cursor ? Number(cursor.replace(/^c/, "")) : NaN;
  const reset = !!cursor && !(at >= 0 && at <= logs.length);
  const from = cursor && !reset ? at : Math.max(0, logs.length - (limit || logs.length));
  const lines = logs.slice(from);
  return ok({ lines, "line-count": lines.length, "latest-timestamp": Math.floor(Date.now() / 1000), "next-cursor": `c${logs.length}`, ...(reset ? { "cursor-reset": true } : {}) });
});
on("DELETE", "/observability/logs", () => {
  logs.length = 0;
  return ok({ message: "Logs cleared successfully", removed: 1 });
});
on("GET", "/observability/logs/errors", () => ok({ files: errorLogs }));
on("GET", "/observability/logs/errors/([^/]+)", (ctx) => {
  const name = decodeURIComponent(ctx.m[1]);
  if (!errorLogs.some((f) => f.name === name)) return fail(404, "log file not found");
  return text(200, `=== REQUEST INFO ===\nURL: /v1/messages\nMethod: POST\n\n=== RESPONSE ===\nStatus: 502\n`, "text/plain; charset=utf-8", { "Content-Disposition": `attachment; filename="${name}"` });
});
on("GET", "/observability/logs/requests/([^/]+)", (ctx) => {
  const id = decodeURIComponent(ctx.m[1]).trim();
  if (!id) return fail(400, "missing request ID");
  return text(200, `=== REQUEST INFO ===\nRequest ID: ${id}\nURL: /v1/messages\nMethod: POST\n\n=== RESPONSE ===\nStatus: 200\n`);
});

// Plugins
on("GET", "/plugins", () => ok({ plugins_enabled: config.plugins.enabled, plugins_dir: "plugins", plugins: plugins.map(pluginView) }));
on("GET", "/plugins/store", () =>
  ok({
    plugins_enabled: config.plugins.enabled,
    plugins_dir: "plugins",
    sources: [{ id: "official", name: "Official", url: "https://plugins.example.invalid/index.json" }],
    plugins: storeCatalog.map((p) => {
      const have = plugins.find((x) => x.id === p.id);
      return { store_id: `official/${p.id}`, source_id: "official", source_name: "Official", source_url: "https://plugins.example.invalid/index.json", ...p, author: "Mock", repository: "", install_type: "binary", auth_required: false, auth_configured: false, installed: !!have, update_available: !!have && have.version !== p.version };
    }),
  }),
);
on("POST", "/plugins/store/([^/]+)/install", (ctx) => {
  const id = decodeURIComponent(ctx.m[1]);
  const p = storeCatalog.find((x) => x.id === id);
  if (!p) return fail(404, "plugin not found in store");
  const have = plugins.find((x) => x.id === id);
  if (have) have.version = p.version;
  else plugins.push({ id, name: p.name, version: p.version, registered: false, enabled: false, oauth: false, quota: false });
  return ok({ status: "installed", source_id: "official", source_name: "Official", id, version: p.version, install_type: "binary", path: `plugins/${id}`, plugins_enabled: config.plugins.enabled });
});
on("POST", "/plugins/([^/]+)/quota", (ctx) => {
  const id = decodeURIComponent(ctx.m[1]);
  if (!plugins.some((p) => p.id === id && p.quota)) return fail(404, "plugin not found");
  return ok({ groups: [{ displayName: "Demo", buckets: [{ window: "5h", remainingFraction: 0.6, resetTime: iso(Date.now() + 3_600_000) }, { window: "7d", remainingFraction: 0.8, resetTime: iso(Date.now() + 86_400_000) }] }] });
});
on("DELETE", "/plugins/([^/]+)", (ctx) => {
  const id = decodeURIComponent(ctx.m[1]);
  const i = plugins.findIndex((p) => p.id === id);
  if (i < 0) return fail(404, "plugin not found");
  plugins.splice(i, 1);
  return ok({ status: "deleted", id, path: `plugins/${id}`, file_deleted: true, configured_removed: true, restart_required: false });
});

// ---------------------------------------------------------------------------------------------
const PREFIX = "/v8/management";
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://mock");
  const send = (status, headers, body) => {
    res.writeHead(status, { "Content-Length": Buffer.byteLength(body ?? ""), ...headers });
    res.end(body);
  };
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const started = process.hrtime.bigint();
    let status = 404;
    try {
      if (url.pathname === "/healthz") return (status = 200), send(200, { "Content-Type": "application/json" }, '{"status":"ok"}');
      if (!url.pathname.startsWith(PREFIX + "/") && url.pathname !== PREFIX) return send(404, {}, "");
      const headers = { "X-CPA-VERSION": VERSION, "X-CPA-COMMIT": "0000000", "X-CPA-BUILD-DATE": "2026-11-08T00:00:00Z", "Cache-Control": "no-store" };
      if (req.method === "OPTIONS") return (status = 204), send(204, { ...headers, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "*" }, "");
      const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || String(req.headers["x-management-key"] || "");
      if (!given) return (status = 401), send(401, { ...headers, "Content-Type": "application/json; charset=utf-8" }, '{"error":"missing management key"}');
      if (given !== KEY) return (status = 401), send(401, { ...headers, "Content-Type": "application/json; charset=utf-8" }, '{"error":"invalid management key"}');
      const sub = url.pathname.slice(PREFIX.length);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(sub);
        if (!m) continue;
        const out = r.handler({ req, q: url.searchParams, body: Buffer.concat(chunks), m });
        status = out.status;
        if (out.raw !== undefined) {
          const type = out.type === "json" ? "application/json; charset=utf-8" : out.type;
          return send(out.status, { ...headers, "Content-Type": type, ...out.headers }, out.raw);
        }
        return send(out.status, { ...headers, "Content-Type": "application/json; charset=utf-8", ...out.headers }, JSON.stringify(out.body));
      }
      send(404, headers, ""); // gin NoRoute
    } catch (e) {
      status = 500;
      console.error(e);
      send(500, {}, JSON.stringify({ error: "internal_error", message: String(e) }));
    } finally {
      if (!opt.quiet) console.log(`${req.method} ${url.pathname}${url.search} ${status} ${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)}ms`);
    }
  });
});
server.listen(Number(opt.port), opt.host, () => {
  const { port } = server.address();
  console.log(`listening http://${opt.host}:${port} accounts=${accounts.length} seed=${opt.seed} key=${KEY}`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
