import type { Credential } from "../../lib/api/credentials.ts";
import type { ApiKeyUsage } from "../../lib/api/observability.ts";
import {
  buckets,
  credState,
  sum,
  sumBuckets,
  type Buckets,
  type CredState,
} from "../../lib/credentials.ts";

export type AttentionRow = { account: Credential; state: CredState };

/** One entry of the alert rail, most urgent first. */
export type Alert =
  { kind: "account"; row: AttentionRow } | { kind: "noKeys" } | { kind: "disabled"; count: number };

export type Summary = {
  total: number;
  ready: number;
  failing: number;
  /** Cooling or out of quota, and the soonest of them to recover. */
  cooling: { count: number; soonest: number | null };
  alerts: Alert[];
};

/**
 * The account counts and the alert rail: failing accounts in list order, the server warning that
 * no client key is set (`keys` undefined while unknown), cooling and out-of-quota accounts by
 * soonest recovery, then the disabled accounts as one entry.
 */
export function summarize(files: Credential[], keys: number | undefined, now: number): Summary {
  const failing: AttentionRow[] = [];
  const cooling: AttentionRow[] = [];
  let ready = 0;
  let disabled = 0;
  for (const account of files) {
    const state = credState(account, now);
    if (state.lamp === "ok") ready++;
    else if (state.lamp === "bad") failing.push({ account, state });
    else if (state.lamp === "warn") cooling.push({ account, state });
    else disabled++;
  }
  cooling.sort((x, y) => (x.state.until ?? Infinity) - (y.state.until ?? Infinity));
  const row = (r: AttentionRow): Alert => ({ kind: "account", row: r });
  const alerts: Alert[] = [
    ...failing.map(row),
    ...(keys === 0 ? [{ kind: "noKeys" as const }] : []),
    ...cooling.map(row),
    ...(disabled ? [{ kind: "disabled" as const, count: disabled }] : []),
  ];
  return {
    total: files.length,
    ready,
    failing: failing.length,
    cooling: { count: cooling.length, soonest: cooling[0]?.state.until ?? null },
    alerts,
  };
}

/** Accounts and provider keys together, per ten-minute bucket; null when nothing reports history. */
export function totalTraffic(files: Credential[], usage: ApiKeyUsage | null): Buckets | null {
  const keys = Object.values(usage ?? {}).flatMap((perKey) => Object.values(perKey).map(buckets));
  return sumBuckets([...files.map(buckets), ...keys]);
}

/** Each bucket's time span as the server writes it ("14:50-15:00"), oldest first. */
export function bucketTimes(files: Credential[], length: number): string[] {
  const reported = files.find((a) => a.recent_requests?.length === length)?.recent_requests;
  return Array.from({ length }, (_, i) => reported?.[i]?.time ?? "");
}

/** Requests, failures and the failed share in the buckets; a null share without requests. */
export function failures(b: Buckets) {
  const total = sum(b.total);
  const failed = sum(b.failed);
  return { total, failed, share: total ? failed / total : null };
}
