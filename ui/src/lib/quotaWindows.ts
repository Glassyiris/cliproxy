import type { Data } from "./json.ts";

type PluginBucket = {
  remainingFraction?: unknown;
  remaining_fraction?: unknown;
  window?: string;
  description?: string;
  resetTime?: string;
  reset_time?: string;
};
type PluginGroup = { displayName?: string; display_name?: string; buckets?: PluginBucket[] };
type CodexLimit = {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: number;
  reset_after_seconds?: unknown;
};
type KimiLimit = { limit: number; used?: unknown; reset_time?: string };
type ClaudeLimit = {
  group?: unknown;
  percent?: unknown;
  scope?: { model?: { display_name?: string } } | null;
  kind?: string;
  resets_at?: string | null;
};
type ClaudeBucket = { utilization?: unknown; resets_at?: string | null };
type QuotaPayload = Data & {
  groups?: PluginGroup[];
  rate_limit?: Record<string, CodexLimit>;
  rateLimit?: Record<string, CodexLimit>;
  usages?: Record<string, KimiLimit>;
  limits?: ClaudeLimit[];
  extra_usage?: {
    is_enabled?: boolean;
    used_credits?: unknown;
    decimal_places?: number;
    currency?: string;
    monthly_limit?: unknown;
    utilization?: unknown;
  };
};
type QuotaObservation = { observed_at?: string; signals?: Record<string, string> };

/**
 * A window's title. Built-in ones are names the dashboard translates, titled as the provider's
 * own CLI titles them; plugin groups and Kimi limits bring their own text from the server.
 */
export type WindowLabel =
  | {
      name:
        | "session"
        | "weekAll"
        | "otherLimit"
        | "extraUsage"
        | "fiveHourLimit"
        | "weeklyLimit"
        | "primaryLimit"
        | "secondaryLimit"
        | "daily"
        | "weekly";
    }
  | { name: "weekModel"; model: string }
  | { name: "lengthLimit"; seconds: number }
  | { text: string };

type Money = { amount: number; currency: string };

/**
 * One usage window. `used` is percent used, or null when the limit has no ceiling (an
 * uncapped extra-usage budget) and only `extra` applies. `source` is the signal-name
 * prefix a passive window was read from. `extra` is Claude's extra-usage spend and its monthly
 * limit, null when there is none.
 */
export type Window = {
  label: WindowLabel;
  used: number | null;
  reset: string;
  source?: string;
  extra?: { spent: Money; limit: Money | null };
};
const clamp = (n: number) => Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;
/** Normalised plugin groups first; then the built-in Claude, Codex and Kimi usage payloads. */
export function quotaWindows(p: string, payload: QuotaPayload): Window[] {
  const out: Window[] = [];
  if (Array.isArray(payload.groups)) {
    for (const g of payload.groups)
      for (const b of g.buckets || []) {
        const left = b.remainingFraction ?? b.remaining_fraction;
        if (typeof left === "number")
          out.push({
            label: {
              text: [g.displayName || g.display_name, b.window || b.description]
                .filter(Boolean)
                .join(" · "),
            },
            used: clamp((1 - left) * 100),
            reset: b.resetTime || b.reset_time || "",
          });
      }
    return out;
  }
  if (p === "claude") return claudeWindows(payload);
  if (p === "codex") {
    for (const [k, v] of Object.entries<CodexLimit>(payload.rate_limit || payload.rateLimit || {}))
      if (v && typeof v.used_percent === "number")
        out.push({
          label: codexWindow(
            Number(v.limit_window_seconds),
            k === "primary_window" ? "primaryLimit" : "secondaryLimit",
          ),
          used: clamp(v.used_percent),
          reset: v.reset_at
            ? new Date(v.reset_at * 1000).toISOString()
            : Number(v.reset_after_seconds) >= 0 && v.reset_after_seconds !== undefined
              ? new Date(Date.now() + Number(v.reset_after_seconds) * 1000).toISOString()
              : "",
        });
  } else if (p === "kimi" || p === "kimi-ai") {
    for (const [k, v] of Object.entries<KimiLimit>(payload.usages || {}))
      if (v?.limit > 0)
        out.push({
          label: { text: k.replaceAll("_", " ") },
          used: clamp((Number(v.used) / Number(v.limit)) * 100),
          reset: String(v.reset_time || ""),
        });
  }
  return out;
}

const percent = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? clamp(v) : null);
/**
 * Claude's legacy buckets, titled as Claude Code's /usage titles them. Anthropic also sends
 * placeholders and buckets Claude Code never shows (iguana_necktie, tangelo,
 * omelette_promotional, seven_day_omelette, seven_day_cowork, seven_day_oauth_apps); they
 * are skipped. cinder_cove has no known title and shows as "Other limit" when set.
 */
const claudeBuckets: [string, WindowLabel][] = [
  ["five_hour", { name: "session" }],
  ["seven_day", { name: "weekAll" }],
  ["seven_day_sonnet", { name: "weekModel", model: "Sonnet" }],
  ["seven_day_opus", { name: "weekModel", model: "Opus" }],
  ["cinder_cove", { name: "otherLimit" }],
];
const money = (minor: number, places: number, currency: string): Money => ({
  amount: minor / 10 ** places,
  currency,
});

/**
 * Anthropic's /api/oauth/usage, rendered the way Claude Code's /usage renders it. When the
 * `limits` list is present it is the only source: rows are classified by `kind` (never by
 * label) and grouped by `group` in the server's order. Without it the legacy buckets apply.
 * Percentages are percent used, 0 to 100; null means the limit does not apply and is left
 * out, never shown as 0%. Extra usage is in cents and shows only when enabled.
 */
function claudeWindows(payload: QuotaPayload): Window[] {
  const out: Window[] = [];
  const limits: ClaudeLimit[] = Array.isArray(payload.limits) ? payload.limits : [];
  if (limits.length) {
    const groups: string[] = [];
    for (const l of limits) if (!groups.includes(String(l?.group))) groups.push(String(l?.group));
    for (const g of groups)
      for (const l of limits) {
        const used = percent(l?.percent);
        if (String(l?.group) !== g || used === null) continue;
        const model = l.scope?.model?.display_name;
        const label: WindowLabel | null =
          l.kind === "session"
            ? { name: "session" }
            : l.kind === "weekly_all"
              ? { name: "weekAll" }
              : l.kind === "weekly_scoped" && model
                ? { name: "weekModel", model: String(model) }
                : null;
        if (label) out.push({ label, used, reset: l.resets_at || "" });
      }
  } else
    for (const [key, label] of claudeBuckets) {
      const used = percent((payload[key] as ClaudeBucket | undefined)?.utilization);
      if (used !== null)
        out.push({ label, used, reset: (payload[key] as ClaudeBucket).resets_at || "" });
    }
  const extra = payload.extra_usage;
  if (extra?.is_enabled === true && typeof extra.used_credits === "number") {
    const places = extra.decimal_places ?? 2;
    const cur = extra.currency || "USD";
    const cap = typeof extra.monthly_limit === "number" ? extra.monthly_limit : null;
    const spent = money(extra.used_credits, places, cur);
    const used =
      cap === null
        ? null
        : (percent(extra.utilization) ?? (cap > 0 ? clamp((extra.used_credits / cap) * 100) : 0));
    out.push({
      label: { name: "extraUsage" },
      used,
      reset: "",
      extra: { spent, limit: cap === null ? null : money(cap, places, cur) },
    });
  }
  return out;
}

/** A Codex rate-limit window by its length, as the Codex CLI names them. */
const codexWindow = (seconds: number, fallback: "primaryLimit" | "secondaryLimit"): WindowLabel =>
  seconds === 18_000
    ? { name: "fiveHourLimit" }
    : seconds === 604_800
      ? { name: "weeklyLimit" }
      : seconds > 0
        ? { name: "lengthLimit", seconds }
        : { name: fallback };

/**
 * Limits the server observed passively, without asking the provider: Codex rate-limit
 * headers (x-codex-primary-*, x-codex-secondary-*), Claude's anthropic-ratelimit-unified-*
 * headers and Devin's daily and weekly quota.
 */
export function signalWindows(p: string, quota: QuotaObservation | undefined): Window[] {
  const sig: Record<string, string> = {};
  for (const [k, v] of Object.entries<string>(quota?.signals || {})) sig[k.toLowerCase()] = v;
  const at = Date.parse(quota?.observed_at as string) || 0;
  const out: Window[] = [];
  if (p === "codex")
    for (const w of ["primary", "secondary"]) {
      const g = (k: string) => sig[`x-codex-${w}-${k}`];
      const used = parseFloat(g("used-percent")),
        minutes = Number(g("window-minutes"));
      if (Number.isNaN(used)) continue;
      const resetAt = Number(g("reset-at")),
        after = Number(g("reset-after-seconds"));
      out.push({
        label: codexWindow(minutes * 60, w === "primary" ? "primaryLimit" : "secondaryLimit"),
        used: clamp(used),
        reset:
          resetAt > 0
            ? new Date(resetAt * 1000).toISOString()
            : after >= 0 && at
              ? new Date(at + after * 1000).toISOString()
              : "",
        source: `x-codex-${w}-`,
      });
    }
  else if (p === "claude")
    // Claude's anthropic-ratelimit-unified-* headers: utilization is a 0 to 1 fraction and
    // reset is Unix seconds. Labels match claudeWindows, so either source looks the same.
    for (const [w, name] of [
      ["5h", "session"],
      ["7d", "weekAll"],
      ["overage", "extraUsage"],
    ] as const) {
      // Only fully numeric, finite values count: "0.5junk" and "Infinity" are not readings.
      const source = `anthropic-ratelimit-unified-${w}-`,
        num = (k: string) => (sig[source + k]?.trim() ? Number(sig[source + k]) : NaN),
        used = num("utilization"),
        reset = new Date(num("reset") * 1000);
      if (!Number.isFinite(used) || sig[source + "disabled-reason"]) continue;
      out.push({
        label: { name },
        used: clamp(used * 100),
        reset: reset.getTime() > 0 ? reset.toISOString() : "",
        source,
      });
    }
  else if (p === "devin")
    for (const w of ["daily", "weekly"]) {
      const left = parseFloat(sig[`${w}_quota_remaining_percent`]);
      if (!Number.isNaN(left))
        out.push({
          label: { name: w === "daily" ? "daily" : "weekly" },
          used: clamp(100 - left),
          reset: sig[`${w}_quota_reset_at`] || "",
          source: `${w}_quota_`,
        });
    }
  return out;
}

/** Signals no window was read from (code-review limits, credits, retry-after), to show as they are. */
export const otherSignals = (
  quota: QuotaObservation | undefined,
  windows: Window[],
): [string, string][] =>
  Object.entries<string>(quota?.signals || {}).filter(
    ([k]) => !windows.some((w) => w.source && k.toLowerCase().startsWith(w.source)),
  );
