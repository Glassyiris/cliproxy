// Live quota checks. A check asks the provider through the server (/requests/api-call with the
// credential's own token, or a quota plugin), so it only ever runs when the user presses a button.
import { available } from "./api/client.ts";
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

export type QuotaReading = { at: number; windows: Window[]; error?: string; code?: number } | { error: string; code?: number };
export type QuotaPending = "queued" | "checking";
export const quotaKey = (a: Credential) => a.auth_index || a.name;

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
  const changed = () => listeners.forEach((l) => l());

  const plugin = (p: string) => sources.plugins().find((x) => x.supports_quota && (x.quota_provider || x.id) === p);
  /** The provider has a usage endpoint or quota plugin this server can call. */
  const hasSource = (a: Credential) =>
    !!plugin(provider(a)) || (!!usageURL[provider(a)] && available(routes.callProvider));
  const canCheck = (a: Credential) => !a.disabled && hasSource(a);
  const gap = (k: string, now: number) => Math.max(0, (tried.get(k) ?? -Infinity) + GAP - now);
  /** Milliseconds until this account may be checked again; a queued or running check counts as a full wait. */
  const wait = (a: Credential, now = Date.now()) => (pending.has(quotaKey(a)) ? GAP : gap(quotaKey(a), now));

  /** Keep known limits visible alongside a failed check: last successful check, else passive signals. */
  function limits(a: Credential): Limits {
    const live = readings.get(quotaKey(a));
    if (live && "windows" in live) return live;
    const windows = signalWindows(provider(a), a.quota);
    return windows.length ? { ...live, windows, at: Date.parse(a.quota?.observed_at ?? "") || 0 } : live || null;
  }

  async function read(a: Credential) {
    const p = provider(a);
    try {
      let raw: Data;
      const pl = plugin(p);
      if (pl) raw = await fetchPluginQuota(pl.id, a.auth_index);
      else {
        const header: Record<string, string> = { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json" };
        if (p === "claude") Object.assign(header, { "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-cli/2.1.280 (external, cli)" });
        if (p === "codex") {
          header["User-Agent"] = "codex-tui/0.149.1";
          const account = a.id_token?.chatgpt_account_id;
          if (account) header["Chatgpt-Account-Id"] = account;
        }
        const r = await callProvider({ authIndex: a.auth_index, method: "GET", url: usageURL[p], header });
        if (r.status_code < 200 || r.status_code >= 300)
          // `code` lets Connect tell a refused token (401/403) from any other failed read.
          throw Object.assign(
            new Error(
              p === "claude" && r.status_code === 403
                ? "Claude denied access to usage (HTTP 403). Setup tokens cannot read usage. Connect Claude through the dashboard's OAuth flow for usage checks."
                : r.status_code === 401 || r.status_code === 403
                  ? `The provider rejected the account's token (HTTP ${r.status_code}). Refresh the token, or connect the account again.`
                  : `The provider answered HTTP ${r.status_code}. Try again later.`,
            ),
            { code: r.status_code },
          );
        raw = typeof r.body === "string" ? JSON.parse(r.body) : r.body;
      }
      readings.set(quotaKey(a), { at: Date.now(), windows: quotaWindows(p, raw) });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      readings.set(quotaKey(a), { ...readings.get(quotaKey(a)), error, code: (e as { code?: number }).code });
    }
  }

  function check(a: Credential) {
    const k = quotaKey(a);
    if (wait(a)) return queue;
    pending.set(k, "queued");
    changed();
    return (queue = queue.then(async () => {
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
        pending.delete(k);
        changed();
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
  };
}
