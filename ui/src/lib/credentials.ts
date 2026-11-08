import { mask } from "./client-keys.ts";
import type { Data } from "./json.ts";
import type { QuotaError } from "./quota.ts";
import type { Window, WindowLabel } from "./quota-windows.ts";
import { spanParts } from "./time.ts";

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
// An api_key credential's `account` is the provider key itself.
const account = (a: Data): unknown =>
  a.account_type === "api_key" && a.account ? mask(String(a.account)) : a.account;
export const credName = (a: Data) => String(a.email || a.label || account(a) || a.name);

/**
 * One state per credential. `state` names the lamp's word: "Disabled", "Limited until <until> ·
 * next check in <time to nextCheck>" (or "on next request" when `nextCheck` is null), "Cooling
 * <time to until>", "Sign in again", "Unavailable", "Error", "Ready", or for "other" the server's
 * own `status`. `detail` is the server's status message; `modelsCooling` counts models of a
 * usable account that are cooling on their own.
 */
export type CredState = {
  lamp: Lamp;
  state:
    | "disabled"
    | "limited"
    | "cooling"
    | "signIn"
    | "unavailable"
    | "error"
    | "ready"
    | "other";
  detail: string;
  status?: string;
  until?: number;
  nextCheck?: number | null;
  modelsCooling?: number;
};
/** One state per credential, derived only from fields Go's /credentials reports. */
export function credState(a: Data, now = Date.now()): CredState {
  if (a.disabled) return { lamp: "off", state: "disabled", detail: "" };
  const all: Data[] = Array.isArray(a.cooldowns) ? a.cooldowns : [];
  // cliproxy-rs: recover_at is the upstream's stated reset when the trust bound cut it.
  const limited = all
    .filter((c) => c.scope !== "model" && Date.parse(c.recover_at) > now)
    .map((c) => [Date.parse(c.recover_at), Date.parse(c.retry_at)])[0];
  const detail = String(a.status_message || "");
  if (limited)
    return {
      lamp: "warn",
      state: "limited",
      detail,
      until: limited[0],
      nextCheck: limited[1] > now ? limited[1] : null,
    };
  const cooldowns = all.filter((c) => Date.parse(c.retry_at) > now);
  const whole = cooldowns.filter((c) => c.scope !== "model");
  const until = Math.min(
    ...whole.map((c) => Date.parse(c.retry_at)),
    a.unavailable && a.next_retry_after ? Date.parse(a.next_retry_after) : Infinity,
  );
  if (until < Infinity && until > now) return { lamp: "warn", state: "cooling", detail, until };
  if (a.unavailable || a.status === "error")
    return {
      lamp: "bad",
      // An expired or revoked sign-in is fixed by connecting the account again.
      state: /\b401\b|unauthori[sz]ed|invalid_grant|revoked|refresh token/i.test(detail)
        ? "signIn"
        : a.unavailable
          ? "unavailable"
          : "error",
      detail,
    };
  const modelsCooling = cooldowns.length - whole.length;
  if (["active", "ok", ""].includes(String(a.status ?? "")))
    return { lamp: "ok", state: "ready", detail: "", modelsCooling };
  return { lamp: "off", state: "other", status: String(a.status), detail: "", modelsCooling };
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
export type Limits =
  | { windows: Window[]; at: number; error?: QuotaError }
  | { error: QuotaError }
  | null;
/**
 * Why a quota cell has no number: "not checked", "not reported", "usage read failed", "no usage
 * windows reported", "no usage source". Unknown quota is never shown as 0% or 100%.
 */
export type QuotaWhy = "notChecked" | "notReported" | "readFailed" | "noWindows" | "noSource";
/** A quota cell: the window, and how old its numbers are when kept past a refused sign-in. */
export type Bar = { window: Window; staleFor: number | null } | { why: QuotaWhy };
export type AccountRow = {
  /** The state's lamp; a Low row's is "warn", though it still serves. */
  lamp: Lamp;
  /** Ready with a request in the latest bucket: the lamp is live and the word is "In use". */
  serving: boolean;
  state: CredState;
  /**
   * "Low quota" (the status filter's word, ahead of "In use"), "In use", "Cooling until <until>"
   * (24-hour clock, weekday when not today), or the state's word.
   */
  word:
    | { kind: "low" }
    | { kind: "inUse" }
    | { kind: "coolingUntil"; until: number }
    | { kind: "state" };
  /**
   * The line under the word: "<Session | Weekly | window> <used>% used" (a Low row, serving or
   * not), "serving now", "can serve now", "token refused", "not in rotation", the server's
   * message, "<n> models cooling", "cooling down", or nothing.
   */
  sub:
    | { kind: "serving" | "canServe" | "tokenRefused" | "notInRotation" | "coolingDown" }
    | { kind: "low"; window: "session" | "weekly" | WindowLabel; used: number }
    | { kind: "detail"; text: string }
    | { kind: "modelsCooling"; count: number }
    | null;
  session: Bar;
  weekly: Bar;
  stale: boolean;
  /** "disabled", "never checked", "checked <ago>" (this tab checked) or "seen <ago>" (the server saw it). */
  age: { kind: "disabled" | "never" } | { kind: "checked" | "seen"; at: number };
  /** "not in <minutes> min", "used now", "used <ago> ago", or null without history. */
  last: { kind: "notIn"; minutes: number } | { kind: "now" } | { kind: "ago"; ms: number } | null;
  /** Weekly reset time for sorting; Infinity when unknown. */
  next: number;
  /** Can serve now: Ready, In use or Low. */
  ready: boolean;
  /** Ready with a reported window at 85% or more; the status filter lists it apart from Ready. */
  low: boolean;
  attention: boolean;
};

const named = (w: Window, names: string[]) => "name" in w.label && names.includes(w.label.name);
const titled = (w: Window, pattern: RegExp) => "text" in w.label && pattern.test(w.label.text);
// Built-in windows by name; plugin windows by the length their title gives ("Pro · 5h", "7d").
const isSession = (w: Window) =>
  named(w, ["session", "fiveHourLimit", "daily", "primaryLimit"]) ||
  titled(w, /session|5-hour|\b5 ?h\b|daily|primary/i);
const isWeek = (w: Window) =>
  named(w, ["weekAll", "weeklyLimit", "weekly"]) || titled(w, /week.*all|^weekly/i);
/** A window whose length `span` writes as 7 days. */
const isSevenDays = (seconds: number) => {
  const [first, ...rest] = spanParts(seconds * 1000);
  return !rest.length && first[1] === "day" && first[0] === 7;
};
const isAnyWeek = (w: Window) =>
  named(w, ["weekModel", "secondaryLimit"]) ||
  ("name" in w.label && w.label.name === "lengthLimit" && isSevenDays(w.label.seconds)) ||
  titled(w, /week|\b7 ?d\b|secondary/i);

function why(a: Data, q: Limits, windows: Window[], source: boolean): QuotaWhy {
  if (a.disabled) return "notChecked";
  if (windows.length) return "notReported";
  if (q && "error" in q && q.error) return "readFailed";
  if (q && "windows" in q) return "noWindows";
  return source ? "notChecked" : "noSource";
}

function sub(s: CredState, ready: boolean, serving: boolean, disabled: boolean, low: AccountRow["sub"]): AccountRow["sub"] {
  if (low) return low;
  if (serving) return { kind: "serving" };
  if (ready) return { kind: "canServe" };
  if (s.state === "signIn") return { kind: "tokenRefused" };
  if (disabled) return { kind: "notInRotation" };
  if (s.detail) return { kind: "detail", text: s.detail };
  if (s.modelsCooling) return { kind: "modelsCooling", count: s.modelsCooling };
  return s.lamp === "warn" ? { kind: "coolingDown" } : null;
}

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
  const session = windows.find(isSession);
  const weekly = windows.find(isWeek) || windows.find(isAnyWeek);
  const stale = s.state === "signIn" && windows.length > 0;
  const none = why(a, q, windows, source);
  const bar = (w?: Window): Bar => (w ? { window: w, staleFor: stale ? now - at : null } : { why: none });
  // Low counts every window the provider reported, named as the bars name them.
  const high = windows.reduce<Window | null>((m, w) => (w.used! > (m?.used ?? -1) ? w : m), null);
  const ready = s.lamp === "ok";
  const serving = ready && !!b && b.total[b.total.length - 1] > 0;
  const low = ready && !!high && high.used! >= 85;
  const lowSub: AccountRow["sub"] =
    low && high
      ? { kind: "low", window: high === session ? "session" : high === weekly ? "weekly" : high.label, used: high.used! }
      : null;
  return {
    lamp: low ? "warn" : s.lamp,
    serving,
    state: s,
    word: low ? { kind: "low" } : serving ? { kind: "inUse" } : s.lamp === "warn" && s.until ? { kind: "coolingUntil", until: s.until } : { kind: "state" },
    sub: sub(s, ready, serving, !!a.disabled, lowSub),
    session: bar(session),
    weekly: bar(weekly),
    stale,
    age: a.disabled ? { kind: "disabled" } : !at ? { kind: "never" } : { kind: live ? "checked" : "seen", at },
    last: !b
      ? null
      : lastAt < 0
        ? { kind: "notIn", minutes: b.total.length * 10 }
        : lastAt === b.total.length - 1
          ? { kind: "now" }
          : { kind: "ago", ms: (b.total.length - 1 - lastAt) * 600_000 },
    next: (weekly && Date.parse(weekly.reset)) || Infinity,
    ready,
    low,
    attention: s.lamp === "bad",
  };
}
