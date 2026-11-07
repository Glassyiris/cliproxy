import type { Data } from "./json.ts";
import type { Window } from "./quota-windows.ts";
import { ago, span } from "./time.ts";

export type Lamp = "ok" | "warn" | "bad" | "off";

const names: Record<string, string> = {
  claude: "Claude",
  anthropic: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  vertex: "Vertex",
  aistudio: "AI Studio",
  antigravity: "Antigravity",
  kimi: "Kimi",
  "kimi-ai": "Kimi (kimi.ai)",
  xai: "xAI",
  meta: "Meta",
  devin: "Devin",
  "openai-compatibility": "OpenAI-compatible",
  interactions: "Interactions",
};
export const label = (id: string) => names[id] || id;
export const provider = (a: Data) => String(a.provider || a.type || "unknown").replace("anthropic", "claude");
export const credName = (a: Data) => String(a.email || a.label || a.account || a.name);

export type CredState = { lamp: Lamp; label: string; detail: string; until?: number };
/** One state per credential, derived only from fields Go's /credentials reports. */
export function credState(a: Data, now = Date.now()): CredState {
  if (a.disabled) return { lamp: "off", label: "Disabled", detail: "" };
  const all: Data[] = Array.isArray(a.cooldowns) ? a.cooldowns : [];
  // cliproxy-rs: recover_at is the upstream's stated reset when the trust bound cut it.
  const limited = all
    .filter((c) => c.scope !== "model" && Date.parse(c.recover_at) > now)
    .map((c) => [Date.parse(c.recover_at), Date.parse(c.retry_at)])[0];
  if (limited) {
    const next = limited[1] > now ? `in ${span(limited[1] - now)}` : "on next request";
    return {
      lamp: "warn",
      label: `Limited until ${new Date(limited[0]).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })} · next check ${next}`,
      detail: a.status_message || "",
      until: limited[0],
    };
  }
  const cooldowns = all.filter((c) => Date.parse(c.retry_at) > now);
  const whole = cooldowns.filter((c) => c.scope !== "model");
  const until = Math.min(
    ...whole.map((c) => Date.parse(c.retry_at)),
    a.unavailable && a.next_retry_after ? Date.parse(a.next_retry_after) : Infinity,
  );
  if (until < Infinity && until > now)
    return { lamp: "warn", label: `Cooling ${span(until - now)}`, detail: a.status_message || "", until };
  if (a.unavailable || a.status === "error")
    return {
      lamp: "bad",
      // An expired or revoked sign-in is fixed by connecting the account again.
      label: /\b401\b|unauthori[sz]ed|invalid_grant|revoked|refresh token/i.test(a.status_message || "")
        ? "Sign in again"
        : a.unavailable ? "Unavailable" : "Error",
      detail: a.status_message || "",
    };
  const models = cooldowns.length - whole.length;
  const detail = models ? `${models} model${models > 1 ? "s" : ""} cooling` : "";
  if (["active", "ok", ""].includes(String(a.status ?? "")))
    return { lamp: "ok", label: "Ready", detail };
  return { lamp: "off", label: String(a.status), detail };
}

export type Buckets = { total: number[]; failed: number[] };
/** Go reports 20 ten-minute buckets per credential. Null means the server did not report history. */
export function buckets(a: Data): Buckets | null {
  if (!Array.isArray(a.recent_requests)) return null;
  const rows = a.recent_requests as Data[];
  return {
    total: rows.map((b) => (Number(b.success) || 0) + (Number(b.failed) || 0)),
    failed: rows.map((b) => Number(b.failed) || 0),
  };
}
export function sumBuckets(list: (Buckets | null)[]): Buckets | null {
  const known = list.filter((b): b is Buckets => !!b);
  if (!known.length) return null;
  const n = Math.max(...known.map((b) => b.total.length));
  const add = (k: keyof Buckets) =>
    Array.from({ length: n }, (_, i) =>
      known.reduce((s, b) => s + (b[k][i - (n - b[k].length)] || 0), 0),
    );
  return { total: add("total"), failed: add("failed") };
}
export const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
/** Map a count to five steps; any non-zero count is at least step 1. */
export const level = (n: number, max: number) => (n <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((n / max) * 4)));

/** A quota read for one credential: windows with when they were read, or only an error. */
export type Limits = { windows: Window[]; at: number; error?: string } | { error: string } | null;
export type Bar = { used: number; reset: string } | { why: string };
export type AccountRow = {
  lamp: string;
  word: string;
  sub: string;
  session: Bar;
  weekly: Bar;
  stale: boolean;
  age: string;
  last: string;
  /** Weekly reset time for sorting; Infinity when unknown. */
  next: number;
  /** Can serve now: Ready or In use. */
  ready: boolean;
  low: boolean;
  attention: boolean;
};
const clock = (t: number, now: number) =>
  new Date(t).toLocaleString([], {
    ...(new Date(t).toDateString() === new Date(now).toDateString() ? {} : { weekday: "short" }),
    // 24-hour, as in the approved design: "Cooling until 14:20" fits the status column.
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
/**
 * One Accounts row, from what the server reports and what this tab read. "In use" is a request
 * in the latest ten-minute bucket; the server does not say which account it picks, who disabled
 * one or when. Unknown quota is never 0% or 100%: it says why.
 * `live`: the windows came from a check made in this tab (else the server observed them).
 */
export function accountRow(a: Data, q: Limits, live: boolean, source: boolean, now = Date.now()): AccountRow {
  const s = credState(a, now);
  const b = buckets(a);
  const lastAt = b ? b.total.map((n) => n > 0).lastIndexOf(true) : -1;
  const windows = q && "windows" in q ? q.windows.filter((w) => w.used !== null) : [];
  const at = q && "windows" in q ? q.at : 0;
  // Built-in labels, and plugin labels by their window length ("Pro · 5h", "7d").
  const session = windows.find((w) => /session|5-hour|\b5 ?h\b|daily|primary/i.test(w.label));
  const weekly = windows.find((w) => /week.*all|^weekly/i.test(w.label)) || windows.find((w) => /week|\b7 ?d\b|secondary/i.test(w.label));
  const signIn = s.label === "Sign in again";
  const stale = signIn && windows.length > 0;
  const why = a.disabled
    ? "not checked"
    : windows.length
      ? "not reported"
      : q && "error" in q && q.error
        ? "usage read failed"
        : q && "windows" in q
          ? "no usage windows reported"
          : source
          ? "not checked"
          : "no usage source";
  const bar = (w?: Window): Bar =>
    w
      ? {
          used: w.used!,
          reset: stale
            ? `${span(now - at)} old`
            : Date.parse(w.reset) > now
              ? `resets in ${span(Date.parse(w.reset) - now)}`
              : "",
        }
      : { why };
  // Low counts every window the provider reported, named as the bars name them.
  const [hi, hiName] = windows.reduce<[number, string]>(
    (m, w) => (w.used! > m[0] ? [w.used!, w === session ? "Session" : w === weekly ? "Weekly" : w.label] : m),
    [-1, ""],
  );
  const ready = s.lamp === "ok";
  const serving = ready && !!b && b.total[b.total.length - 1] > 0;
  const low = ready && hi >= 85;
  return {
    lamp: serving ? "ok live" : s.lamp,
    word: serving ? "In use" : s.lamp === "warn" && s.until ? `Cooling until ${clock(s.until, now)}` : s.label,
    sub: serving
      ? "serving now"
      : low
        ? `${hiName} ${hi}% used`
        : ready
          ? "can serve now"
          : signIn
            ? "token refused"
            : a.disabled
              ? "not in rotation"
              : s.detail || (s.lamp === "warn" ? "cooling down" : ""),
    session: bar(session),
    weekly: bar(weekly),
    stale,
    age: a.disabled ? "disabled" : !at ? "never checked" : `${live ? "checked" : "seen"} ${ago(at, now)}`,
    last: !b ? "" : lastAt < 0 ? `not in ${b.total.length * 10} min` : lastAt === b.total.length - 1 ? "used now" : `used ${span((b.total.length - 1 - lastAt) * 600_000)} ago`,
    next: (weekly && Date.parse(weekly.reset)) || Infinity,
    ready,
    low,
    attention: s.lamp === "bad",
  };
}
