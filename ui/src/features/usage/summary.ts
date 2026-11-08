import type { Credential } from "../../lib/api/credentials.ts";
import type { ApiKeyUsage, UsageRecord } from "../../lib/api/observability.ts";
import { buckets, provider, sum, sumBuckets, type Buckets } from "../../lib/credentials.ts";
import { cleanEvent, type UsageEvent } from "../../lib/usage.ts";

export type Source = {
  key: string;
  via: "accounts" | "keys";
  provider: string;
  /** Null when the server reports no history for this source. */
  buckets: Buckets | null;
  total: number;
  failed: number;
};

function byProvider(via: Source["via"], entries: [string, Buckets | null][]): Source[] {
  const groups = new Map<string, (Buckets | null)[]>();
  for (const [p, b] of entries) {
    const list = groups.get(p);
    if (list) list.push(b);
    else groups.set(p, [b]);
  }
  return [...groups].map(([p, list]) => {
    const b = sumBuckets(list);
    return {
      key: `${via}:${p}`,
      via,
      provider: p,
      buckets: b,
      total: b ? sum(b.total) : 0,
      failed: b ? sum(b.failed) : 0,
    };
  });
}

/**
 * One row per provider through accounts and per provider through provider keys, busiest first.
 * A source that is not read (null) contributes no rows.
 */
export function sources(files: Credential[] | null, usage: ApiKeyUsage | null): Source[] {
  return [
    ...byProvider(
      "accounts",
      (files ?? []).map((a) => [provider(a), buckets(a)]),
    ),
    ...byProvider(
      "keys",
      Object.entries(usage ?? {}).flatMap(([p, perKey]) =>
        Object.values(perKey).map((entry): [string, Buckets | null] => [p, buckets(entry)]),
      ),
    ),
  ].sort((x, y) => y.total - x.total);
}

/** The buckets of the source `key`, or of every source when it is empty or unknown. */
export function trafficOf(rows: Source[], key: string): Buckets | null {
  const one = rows.find((r) => r.key === key);
  return one ? one.buckets : sumBuckets(rows.map((r) => r.buckets));
}

/** Each bucket's time span as the server writes it ("14:50-15:00"), oldest first. */
export function bucketTimes(files: Credential[] | null, length: number): string[] {
  const reported = files?.find((a) => a.recent_requests?.length === length)?.recent_requests;
  return Array.from({ length }, (_, i) => reported?.[i]?.time ?? "");
}

/**
 * The facts the written conclusions name: the busiest bucket and the one with the most failures
 * (null without any), or the source with the most requests and the one failing most often.
 */
export function peaks(b: Buckets) {
  const top = (v: number[]) => {
    const max = Math.max(0, ...v);
    return max > 0 ? { at: v.indexOf(max), count: max } : null;
  };
  return {
    total: sum(b.total),
    failed: sum(b.failed),
    busiest: top(b.total),
    worst: top(b.failed),
  };
}

export function leaders(rows: Source[]) {
  const all = rows.reduce((n, r) => n + r.total, 0);
  const served = rows.filter((r) => r.total > 0);
  if (!served.length) return null;
  const share = (r: Source) => r.failed / r.total;
  const busiest = served.reduce((a, b) => (b.total > a.total ? b : a));
  const worst = served.reduce((a, b) => (share(b) > share(a) ? b : a));
  return {
    busiest,
    busiestShare: busiest.total / all,
    worst: worst.failed > 0 ? worst : null,
    worstShare: share(worst),
  };
}

const HOUR_MS = 3_600_000;
const KEPT = 2_000;

/** The events of the last hour; the tab keeps nothing older, drained or not. */
export const recent = (events: UsageEvent[], now: number) =>
  events.filter((e) => e.at > now - HOUR_MS);

/** The tab's events after one drain: records that are not JSON are dropped, then the last hour, at most 2,000. */
export function addBatch(
  events: UsageEvent[],
  batch: (UsageRecord | string)[],
  now: number,
): UsageEvent[] {
  const added = batch.filter((r): r is UsageRecord => !!r && typeof r === "object").map(cleanEvent);
  return recent([...events, ...added], now).slice(-KEPT);
}
