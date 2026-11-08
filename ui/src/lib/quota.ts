// Live quota checks. A check asks the provider through the server (/requests/api-call with the
// credential's own token, or a quota plugin), so it only ever runs when the user presses a button.
import { ApiError, available, ConnectionError } from "./api/client.ts";
import type { Credential } from "./api/credentials.ts";
import type { Plugin } from "./api/plugins.ts";
import { fetchPluginQuota } from "./api/plugins.ts";
import { callProvider } from "./api/requests.ts";
import { routes } from "./api/routes.ts";
import { provider, type Limits } from "./credentials.ts";
import type { Data } from "./json.ts";
import { quotaWindows, signalWindows, type Window } from "./quota-windows.ts";

// Usage endpoints the server calls with the credential's own token ($TOKEN$ is substituted server-side).
const usageURL: Record<string, string> = {
  claude: "https://api.anthropic.com/api/oauth/usage",
  codex: "https://chatgpt.com/backend-api/wham/usage",
  kimi: "https://api.kimi.com/coding/v1/usages",
  "kimi-ai": "https://api.kimi.ai/coding/v1/usages",
};
const GAP = 120_000;

/**
 * Why a check failed, as a code the page words: the provider's HTTP status for a refused read
 * (`usageDenied` is Claude refusing a setup token), the connection to this server, an answer
 * that is not usage data (`malformed`), or the server's own message, which may carry the
 * provider's.
 */
export type QuotaError =
  | { reason: "usageDenied" | "tokenRefused" | "status"; status: number }
  | { reason: "timeout" | "unreachable" | "malformed" }
  | { reason: "failed"; detail: string };

export type QuotaReading =
  | { at: number; windows: Window[]; error?: QuotaError; code?: number }
  | { error: QuotaError; code?: number };

/** Usage endpoint or quota plugin for this account's provider, whether or not this server offers the route a check needs. */
export const quotaApplies = (a: Credential, plugins: Plugin[]) =>
  !!quotaPlugin(plugins, provider(a)) || !!usageURL[provider(a)];

const quotaPlugin = (plugins: Plugin[], p: string) =>
  plugins.find((x) => x.supports_quota && (x.quota_provider || x.id) === p);

const refusal = (p: string, status: number): QuotaError => ({
  reason:
    p === "claude" && status === 403
      ? "usageDenied"
      : status === 401 || status === 403
        ? "tokenRefused"
        : "status",
  status,
});

/** What a failed request records; null for an ended session, whose answer has no reader. */
function failure(e: unknown): QuotaError | null {
  if (e instanceof ConnectionError) {
    if (e.reason === "signed-out" || e.reason === "session-changed") return null;
    return { reason: e.reason === "timeout" ? "timeout" : "unreachable" };
  }
  if (e instanceof ApiError) return { reason: "failed", detail: e.message };
  return { reason: "malformed" };
}
export type QuotaPending = "queued" | "checking";
const quotaKey = (a: Credential) => a.auth_index || a.name;

/** Where the checker reads the current plugins and credentials from. */
export type QuotaSources = { plugins(): Plugin[]; credentials(): Credential[] };

/**
 * Checks run one at a time, and each account at most once every 2 minutes counted from when its
 * request is sent, so a burst of clicks never turns into a burst of provider requests. Readings
 * stay in this tab only.
 */
export function createQuotaChecker(sources: QuotaSources) {
  const readings = new Map<string, QuotaReading>();
  const pending = new Map<string, QuotaPending>();
  const tried = new Map<string, number>();
  const listeners = new Set<() => void>();
  let queue: Promise<unknown> = Promise.resolve();
  // Bumped by stop(): a queued check made before it is dropped.
  let epoch = 0;
  const changed = () => listeners.forEach((l) => l());

  const plugin = (p: string) => quotaPlugin(sources.plugins(), p);
  /** The provider has a usage endpoint or quota plugin this server can call. */
  const hasSource = (a: Credential) =>
    !!plugin(provider(a)) || (!!usageURL[provider(a)] && available(routes.callProvider));
  const canCheck = (a: Credential) => !a.disabled && hasSource(a);
  const gap = (k: string, now: number) => Math.max(0, (tried.get(k) ?? -Infinity) + GAP - now);
  /** Milliseconds until this account may be checked again; a queued or running check counts as a full wait. */
  const wait = (a: Credential, now = Date.now()) =>
    pending.has(quotaKey(a)) ? GAP : gap(quotaKey(a), now);

  /** Keep known limits visible alongside a failed check: last successful check, else passive signals. */
  function limits(a: Credential): Limits {
    const live = readings.get(quotaKey(a));
    if (live && "windows" in live) return live;
    const windows = signalWindows(provider(a), a.quota);
    return windows.length
      ? { ...live, windows, at: Date.parse(a.quota?.observed_at ?? "") || 0 }
      : live || null;
  }

  async function read(a: Credential) {
    const p = provider(a);
    // A failed read keeps the last windows beside it. `code` lets Connect tell a refused token
    // (401/403) from any other failed read.
    const fail = (error: QuotaError, code?: number) =>
      void readings.set(quotaKey(a), { ...readings.get(quotaKey(a)), error, code });
    let raw: unknown;
    try {
      const pl = plugin(p);
      if (pl) raw = await fetchPluginQuota(pl.id, a.auth_index);
      else {
        const header: Record<string, string> = {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
        };
        if (p === "claude")
          Object.assign(header, {
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "claude-cli/2.1.280 (external, cli)",
          });
        if (p === "codex") {
          header["User-Agent"] = "codex-tui/0.149.1";
          // The file's own account_id first, as the Svelte dashboard sent it; the token's claim
          // is the fallback.
          const account = a.account_id || a.id_token?.chatgpt_account_id;
          if (account) header["Chatgpt-Account-Id"] = account;
        }
        const r = await callProvider({
          authIndex: a.auth_index,
          method: "GET",
          url: usageURL[p],
          header,
        });
        if (r.status_code < 200 || r.status_code >= 300)
          return fail(refusal(p, r.status_code), r.status_code);
        raw = r.body;
      }
    } catch (e) {
      const error = failure(e);
      return error ? fail(error) : undefined;
    }
    // The provider's answer is checked here, not the server's: a body that does not parse or
    // has an unexpected shape is `malformed`, never the browser's own message.
    try {
      const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as Data;
      readings.set(quotaKey(a), { at: Date.now(), windows: quotaWindows(p, data) });
    } catch {
      fail({ reason: "malformed" });
    }
  }

  function check(a: Credential) {
    const k = quotaKey(a);
    if (wait(a)) return queue;
    const at = epoch;
    pending.set(k, "queued");
    changed();
    return (queue = queue.then(async () => {
      if (at !== epoch) return;
      try {
        // Right before the request goes out, the account as it is now must still exist, be
        // checkable and be due; only then is the time stamped.
        const now = sources.credentials().find((x) => quotaKey(x) === k);
        if (!now || !canCheck(now) || gap(k, Date.now())) return;
        tried.set(k, Date.now());
        pending.set(k, "checking");
        changed();
        await read(now);
      } finally {
        if (at === epoch) {
          pending.delete(k);
          changed();
        }
      }
    }));
  }

  /** One check per supported credential that is due, one after another. */
  async function checkAll(list: Credential[]) {
    for (const a of list) if (canCheck(a)) check(a);
    await queue;
  }

  return {
    hasSource,
    canCheck,
    wait,
    limits,
    check,
    checkAll,
    reading: (a: Credential) => readings.get(quotaKey(a)),
    pending: (a: Credential) => pending.get(quotaKey(a)),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /**
     * For sign-out: every queued check is dropped without reading the sources or sending. A
     * check already sent still finishes, unannounced. Checks asked later run again, as React's
     * StrictMode remounts the provider with the same checker.
     */
    stop() {
      epoch++;
      pending.clear();
      changed();
    },
  };
}
