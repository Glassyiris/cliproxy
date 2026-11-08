import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Credential } from "../../lib/api/credentials.ts";
import type { UsageRecord } from "../../lib/api/observability.ts";
import { cleanEvent } from "../../lib/usage.ts";
import { addBatch, leaders, peaks, recent, sources, trafficOf } from "./summary.ts";

const bucketsOf = (...pairs: [number, number][]) =>
  pairs.map(([success, failed]) => ({ time: "", success, failed }));
const account = (name: string, fields: Partial<Credential> = {}) =>
  ({ name, provider: "codex", status: "active", cooldowns: [], ...fields }) as Credential;

test("sources: accounts summed per provider, keys per provider, busiest first, unreported last", () => {
  const files = [
    account("a", { recent_requests: bucketsOf([1, 0], [1, 1]) }),
    account("b", { recent_requests: bucketsOf([0, 0], [1, 0]) }),
    account("c", { provider: "claude", recent_requests: undefined as never }),
  ];
  const usage = {
    codex: {
      "u|k1": { success: 0, failed: 0, recent_requests: bucketsOf([5, 0], [0, 0]) },
      "u|k2": { success: 0, failed: 0, recent_requests: bucketsOf([0, 0], [2, 2]) },
    },
  };
  const rows = sources(files, usage);
  assert.deepEqual(
    rows.map((r) => [r.key, r.buckets, r.total, r.failed]),
    [
      ["keys:codex", { total: [5, 4], failed: [0, 2] }, 9, 2],
      ["accounts:codex", { total: [1, 3], failed: [0, 1] }, 4, 1],
      ["accounts:claude", null, 0, 0],
    ],
  );
  assert.deepEqual(trafficOf(rows, "accounts:codex"), { total: [1, 3], failed: [0, 1] });
  assert.deepEqual(trafficOf(rows, ""), { total: [6, 7], failed: [0, 3] });
  assert.equal(trafficOf(rows, "accounts:claude"), null);
});

test("sources: an unread source adds no rows", () => {
  assert.deepEqual(sources(null, null), []);
  const rows = sources(null, {
    gemini: { "u|k": { success: 0, failed: 0, recent_requests: bucketsOf([0, 0]) } },
  });
  assert.deepEqual(
    rows.map((r) => r.via),
    ["keys"],
  );
});

test("peaks: the busiest bucket and the one with most failures, none without requests", () => {
  assert.deepEqual(peaks({ total: [2, 9, 9, 4], failed: [0, 1, 3, 3] }), {
    total: 24,
    failed: 7,
    busiest: { at: 1, count: 9 },
    worst: { at: 2, count: 3 },
  });
  assert.deepEqual(peaks({ total: [0, 0], failed: [0, 0] }).busiest, null);
});

test("leaders: the busiest source by requests, the worst by failed share, none without failures", () => {
  const files = [
    account("a", { recent_requests: bucketsOf([8, 2]) }),
    account("b", { provider: "claude", recent_requests: bucketsOf([1, 1]) }),
  ];
  const lead = leaders(sources(files, null));
  assert.equal(lead?.busiest.key, "accounts:codex");
  assert.equal(lead?.busiestShare, 10 / 12);
  assert.equal(lead?.worst?.key, "accounts:claude");
  assert.equal(lead?.worstShare, 0.5);
  const calm = leaders(sources([account("a", { recent_requests: bucketsOf([3, 0]) })], null));
  assert.equal(calm?.worst, null);
  assert.equal(leaders(sources(null, null)), null);
});

const now = Date.parse("2026-11-08T12:00:00Z");
const record = (id: string, ago: number) =>
  ({ request_id: id, timestamp: new Date(now - ago).toISOString(), model: "m" }) as UsageRecord;

test("addBatch: drops records that are not JSON and events older than one hour", () => {
  const kept = cleanEvent(record("old-but-kept", 3_599_000));
  const stale = cleanEvent(record("stale", 3_600_000));
  const next = addBatch([stale, kept], ["not json", record("new", 0)], now);
  assert.deepEqual(
    next.map((e) => e.id),
    ["old-but-kept", "new"],
  );
});

test("addBatch: keeps the newest 2,000", () => {
  const many = Array.from({ length: 1_999 }, (_, i) => cleanEvent(record(`e${i}`, 1_000)));
  const next = addBatch(many, [record("x", 0), record("y", 0)], now);
  assert.equal(next.length, 2_000);
  assert.equal(next[0].id, "e1");
  assert.equal(next.at(-1)?.id, "y");
});

test("recent: an hour after the last drain the held events are gone", () => {
  const held = [cleanEvent(record("a", 0)), cleanEvent(record("b", -30 * 60_000))];
  assert.deepEqual(
    recent(held, now + 75 * 60_000).map((e) => e.id),
    ["b"],
  );
  assert.deepEqual(recent(held, now + 2 * 3_600_000), []);
});
