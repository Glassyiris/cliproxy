import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Credential } from "../../lib/api/credentials.ts";
import { bucketTimes, failures, sources, summarize, totalTraffic } from "./summary.ts";

const now = Date.parse("2026-11-08T12:00:00Z");
const at = (ms: number) => new Date(now + ms).toISOString();
const account = (name: string, fields: Partial<Credential> = {}) =>
  ({ name, provider: "codex", status: "active", cooldowns: [], ...fields }) as Credential;
const cooling = (name: string, ms: number) =>
  account(name, {
    cooldowns: [{ scope: "credential", reason: "quota", retry_at: at(ms), remaining_seconds: 0 }],
  });
const bucketsOf = (...pairs: [number, number][]) =>
  pairs.map(([success, failed], i) => ({ time: `t${i}`, success, failed }));

test("alerts: one card per reason, failing first, then the no-key warning; waits carry the soonest", () => {
  const files = [
    cooling("late", 3 * 3_600_000),
    account("ready"),
    account("broken", { status: "error", status_message: "boom" }),
    cooling("soon", 60_000),
    account("off", { disabled: true, status: "disabled", unavailable: true }),
    account("revoked", { status: "error", unavailable: true, status_message: "unauthorized" }),
    account("expired", { status: "error", status_message: "invalid refresh token" }),
  ];
  const s = summarize(files, 0, now);
  assert.deepEqual(s.alerts, [
    { kind: "group", reason: "signIn", count: 2, soonest: null },
    { kind: "group", reason: "error", count: 1, soonest: null },
    { kind: "noKeys" },
    { kind: "group", reason: "cooling", count: 2, soonest: now + 60_000 },
    { kind: "group", reason: "disabled", count: 1, soonest: null },
  ]);
  assert.deepEqual(
    { total: s.total, ready: s.ready, failing: s.failing },
    { total: 7, ready: 1, failing: 3 },
  );
  // Keys configured, or not read yet: no warning.
  assert.ok(summarize(files, 2, now).alerts.every((a) => a.kind !== "noKeys"));
  assert.ok(summarize(files, undefined, now).alerts.every((a) => a.kind !== "noKeys"));
});

test("traffic: accounts and provider keys add up per bucket and per source; nothing reported is null", () => {
  const files = [
    account("a", { recent_requests: bucketsOf([2, 1], [3, 0]) }),
    account("c", { provider: "claude", recent_requests: undefined as never }),
  ];
  const usage = {
    openrouter: { "u|k1": { success: 0, failed: 0, recent_requests: bucketsOf([4, 2], [0, 0]) } },
  };
  assert.deepEqual(totalTraffic(files, usage), { total: [9, 3], failed: [3, 0] });
  assert.equal(totalTraffic([files[1]], null), null);
  assert.deepEqual(bucketTimes(files, 2), ["t0", "t1"]);
  assert.deepEqual(bucketTimes([files[1]], 2), ["", ""]);
  assert.deepEqual(sources(files, usage), [
    { kind: "accounts", provider: "codex", total: 6, failed: 1 },
    { kind: "keys", provider: "openrouter", total: 6, failed: 2 },
  ]);
});

test("failures: none without requests, else the failed share", () => {
  assert.deepEqual(failures({ total: [0, 0], failed: [0, 0] }), {
    total: 0,
    failed: 0,
    share: null,
  });
  assert.deepEqual(failures({ total: [6, 2], failed: [2, 0] }), {
    total: 8,
    failed: 2,
    share: 0.25,
  });
});

test("key-only traffic supplies bucket times without OAuth accounts", () => {
  const history = bucketsOf([4, 1], [2, 0]);
  const usage = { openrouter: { key: { success: 6, failed: 1, recent_requests: history } } };
  assert.deepEqual(bucketTimes([], 2, usage), ["t0", "t1"]);
  assert.deepEqual(bucketTimes([account("a", { recent_requests: bucketsOf([1, 0]) })], 2, usage), [
    "t0",
    "t1",
  ]);
  assert.deepEqual(bucketTimes([], 3, usage), ["", "", ""]);
});
