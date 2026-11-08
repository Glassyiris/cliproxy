import type { Credential } from "../../lib/api/credentials.ts";
import type { ApiKeyUsage } from "../../lib/api/observability.ts";
import {
  buckets,
  credState,
  provider,
  sum,
  sumBuckets,
  type Buckets,
  type CredState,
} from "../../lib/credentials.ts";

export type AttentionRow = { account: Credential; state: CredState };

/** Why an account cannot serve, most urgent first. */
const reasons = [
  "signIn",
  "unavailable",
  "error",
  "limited",
  "cooling",
  "disabled",
  "other",
] as const;
export type Reason = (typeof reasons)[number];

/** One row of the alert rail: the accounts that share a reason, or a server warning. */
export type Alert = { kind: "group"; reason: Reason; rows: AttentionRow[] } | { kind: "noKeys" };

export type Summary = {
  total: number;
  ready: number;
  failing: number;
  /** Cooling or out of quota, and the soonest of them to recover. */
  cooling: { count: number; soonest: number | null };
  alerts: Alert[];
};

const recovery = (r: AttentionRow) => r.state.until ?? Infinity;

/**
 * The account counts and the alert rail: one group per reason in `reasons` order, accounts in list
 * order except cooling and out-of-quota ones, which go soonest recovery first; the warning that no
 * client key is set (`keys` undefined while unknown) comes after the failing groups.
 */
export function summarize(files: Credential[], keys: number | undefined, now: number): Summary {
  const groups = new Map<Reason, AttentionRow[]>(reasons.map((r) => [r, []]));
  let ready = 0;
  for (const account of files) {
    const state = credState(account, now);
    if (state.state === "ready") ready++;
    else groups.get(state.state)?.push({ account, state });
  }
  const of = (reason: Reason) => groups.get(reason) ?? [];
  const group = (reason: Reason): Alert[] => {
    const rows = of(reason);
    if (reason === "limited" || reason === "cooling")
      rows.sort((x, y) => recovery(x) - recovery(y));
    return rows.length ? [{ kind: "group", reason, rows }] : [];
  };
  const waiting = [...of("limited"), ...of("cooling")];
  const soonest = Math.min(...waiting.map(recovery));
  return {
    total: files.length,
    ready,
    failing: of("signIn").length + of("unavailable").length + of("error").length,
    cooling: { count: waiting.length, soonest: soonest < Infinity ? soonest : null },
    alerts: [
      ...(["signIn", "unavailable", "error"] as const).flatMap(group),
      ...(keys === 0 ? [{ kind: "noKeys" as const }] : []),
      ...(["limited", "cooling", "disabled", "other"] as const).flatMap(group),
    ],
  };
}

/** Where traffic came in: one provider's accounts, or one provider's keys. */
export type Source = { kind: "accounts" | "keys"; provider: string; total: number; failed: number };

/** Requests and failures per source over the 200 minutes; sources without history are left out. */
export function sources(files: Credential[], usage: ApiKeyUsage | null): Source[] {
  const totals = new Map<string, Source>();
  const add = (kind: Source["kind"], p: string, b: Buckets | null) => {
    if (!b) return;
    const key = `${kind}\u0000${p}`;
    const entry = totals.get(key) ?? { kind, provider: p, total: 0, failed: 0 };
    entry.total += sum(b.total);
    entry.failed += sum(b.failed);
    totals.set(key, entry);
  };
  for (const account of files) add("accounts", provider(account), buckets(account));
  for (const [p, perKey] of Object.entries(usage ?? {}))
    for (const entry of Object.values(perKey)) add("keys", p, buckets(entry));
  return [...totals.values()];
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
