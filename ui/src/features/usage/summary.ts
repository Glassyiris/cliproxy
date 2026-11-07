import type { Credential } from "../../lib/api/credentials.ts";
import type { ApiKeyUsage, UsageRecord } from "../../lib/api/observability.ts";
import { buckets, provider, sum, sumBuckets, type Buckets } from "../../lib/credentials.ts";
import { cleanEvent, type UsageEvent } from "../../lib/usage.ts";

export type Source = { via: "accounts" | "keys"; provider: string; buckets: Buckets | null };

const total = (s: Source) => (s.buckets ? sum(s.buckets.total) : 0);

function byProvider(via: Source["via"], entries: [string, Buckets | null][]): Source[] {
  const groups = new Map<string, (Buckets | null)[]>();
  for (const [p, b] of entries) {
    const list = groups.get(p);
    if (list) list.push(b);
    else groups.set(p, [b]);
  }
  return [...groups].map(([p, list]) => ({ via, provider: p, buckets: sumBuckets(list) }));
}

/**
 * One row per provider through accounts and per provider through provider keys, busiest first.
 * A source that is not read (null) contributes no rows; `max` is the busiest bucket of every row.
 */
export function sources(files: Credential[] | null, usage: ApiKeyUsage | null) {
  const rows = [
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
  ].sort((x, y) => total(y) - total(x));
  return { rows, max: Math.max(1, ...rows.flatMap((r) => r.buckets?.total ?? [])) };
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
