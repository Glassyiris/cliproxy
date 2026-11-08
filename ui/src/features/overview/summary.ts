import type { Credential } from "../../lib/api/credentials.ts";
import type { ApiKeyUsage } from "../../lib/api/observability.ts";
import {
  buckets,
  credState,
  provider,
  sum,
  sumBuckets,
  type Buckets,
} from "../../lib/credentials.ts";

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

/**
 * One "Needs attention" card: how many accounts share a reason and, for those waiting on a reset,
 * the soonest one back; or the server warning that no client key is set.
 */
export type Alert =
  { kind: "group"; reason: Reason; count: number; soonest: number | null } | { kind: "noKeys" };

export type Summary = { total: number; ready: number; failing: number; alerts: Alert[] };

const failingReasons = ["signIn", "unavailable", "error"] as const;

/**
 * The account counts and the attention cards: one per reason with accounts, in `reasons` order,
 * with the warning that no client key is set (`keys` undefined while unknown) after the failing
 * ones.
 */
export function summarize(files: Credential[], keys: number | undefined, now: number): Summary {
  const groups = new Map<Reason, { count: number; soonest: number }>(
    reasons.map((r) => [r, { count: 0, soonest: Infinity }]),
  );
  let ready = 0;
  for (const account of files) {
    const state = credState(account, now);
    const group = state.state === "ready" ? undefined : groups.get(state.state);
    if (!group) {
      ready++;
      continue;
    }
    group.count++;
    group.soonest = Math.min(group.soonest, state.until ?? Infinity);
  }
  const alerts = (list: readonly Reason[]): Alert[] =>
    list.flatMap((reason) => {
      const { count, soonest } = groups.get(reason) ?? { count: 0, soonest: Infinity };
      if (!count) return [];
      const waits = reason === "limited" || reason === "cooling";
      return [
        { kind: "group", reason, count, soonest: waits && soonest < Infinity ? soonest : null },
      ];
    });
  return {
    total: files.length,
    ready,
    failing: failingReasons.reduce((n, r) => n + (groups.get(r)?.count ?? 0), 0),
    alerts: [
      ...alerts(failingReasons),
      ...(keys === 0 ? [{ kind: "noKeys" as const }] : []),
      ...alerts(["limited", "cooling", "disabled", "other"]),
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
export function bucketTimes(
  files: Credential[],
  length: number,
  usage: ApiKeyUsage | null = null,
): string[] {
  const keys = Object.values(usage ?? {}).flatMap((perKey) => Object.values(perKey));
  const reported = [...files, ...keys].find(
    (a) => a.recent_requests?.length === length,
  )?.recent_requests;
  return Array.from({ length }, (_, i) => reported?.[i]?.time ?? "");
}

/** Requests, failures and the failed share in the buckets; a null share without requests. */
export function failures(b: Buckets) {
  const total = sum(b.total);
  const failed = sum(b.failed);
  return { total, failed, share: total ? failed / total : null };
}
