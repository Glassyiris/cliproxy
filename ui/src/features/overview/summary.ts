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
  type Lamp,
} from "../../lib/credentials.ts";

export type LampCounts = Record<Lamp, number>;

export function lampCounts(files: Credential[], now: number): LampCounts {
  const counts: LampCounts = { ok: 0, warn: 0, bad: 0, off: 0 };
  for (const a of files) counts[credState(a, now).lamp]++;
  return counts;
}

export type AttentionRow = { account: Credential; state: CredState };

/** Failing accounts first, in list order; then cooling ones, the soonest to recover first. */
export function needsAttention(files: Credential[], now: number): AttentionRow[] {
  const rows = files
    .map((account) => ({ account, state: credState(account, now) }))
    .filter((r) => r.state.lamp === "bad" || r.state.lamp === "warn");
  const rank = (r: AttentionRow) => (r.state.lamp === "bad" ? 0 : (r.state.until ?? Infinity));
  return rows.sort((x, y) => rank(x) - rank(y));
}

type TrafficRow = { provider: string; buckets: Buckets | null };
export type Traffic = {
  all: Buckets | null;
  accounts: TrafficRow[];
  keys: TrafficRow[];
  /** The busiest bucket of every row, so the strips compare. */
  max: number;
};

function byProvider(entries: [string, Buckets | null][]): TrafficRow[] {
  const groups = new Map<string, (Buckets | null)[]>();
  for (const [p, b] of entries) {
    const list = groups.get(p);
    if (list) list.push(b);
    else groups.set(p, [b]);
  }
  return [...groups].map(([p, list]) => ({ provider: p, buckets: sumBuckets(list) }));
}

/** All traffic, then per provider for accounts and for provider keys; `usage` null when not read. */
export function traffic(files: Credential[], usage: ApiKeyUsage | null): Traffic {
  const accounts = byProvider(files.map((a) => [provider(a), buckets(a)]));
  const keys = byProvider(
    Object.entries(usage ?? {}).flatMap(([p, perKey]) =>
      Object.values(perKey).map((entry): [string, Buckets | null] => [p, buckets(entry)]),
    ),
  );
  const rows = [...accounts, ...keys];
  const all = sumBuckets(rows.map((r) => r.buckets));
  return { all, accounts, keys, max: Math.max(1, ...(all?.total ?? [])) };
}

/** Requests and failures in the buckets, and the share that succeeded; null rate with none. */
export function successRate(b: Buckets | null) {
  if (!b) return null;
  const total = sum(b.total);
  const failed = sum(b.failed);
  return { total, failed, rate: total ? (total - failed) / total : null };
}
