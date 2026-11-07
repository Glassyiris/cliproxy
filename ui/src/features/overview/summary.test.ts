import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Credential } from "../../lib/api/credentials.ts";
import { needsAttention, successRate, traffic } from "./summary.ts";

const now = Date.parse("2026-11-08T12:00:00Z");
const at = (ms: number) => new Date(now + ms).toISOString();
const account = (name: string, fields: Partial<Credential> = {}) =>
  ({ name, provider: "codex", status: "active", cooldowns: [], ...fields }) as Credential;
const cooling = (name: string, ms: number) =>
  account(name, {
    cooldowns: [{ scope: "credential", reason: "quota", retry_at: at(ms), remaining_seconds: 0 }],
  });
const bucketsOf = (...pairs: [number, number][]) =>
  pairs.map(([success, failed]) => ({ time: "", success, failed }));

test("attention: failing first in list order, then cooling by soonest recovery; ready and disabled left out", () => {
  const files = [
    cooling("late", 3 * 3_600_000),
    account("ready"),
    account("broken", { status: "error", status_message: "boom" }),
    cooling("soon", 60_000),
    account("off", { disabled: true, status: "disabled", unavailable: true }),
    account("revoked", { status: "error", unavailable: true, status_message: "unauthorized" }),
  ];
  assert.deepEqual(
    needsAttention(files, now).map((r) => r.account.name),
    ["broken", "revoked", "soon", "late"],
  );
});

test("traffic: groups accounts and provider keys by provider; accounts without history stay unknown", () => {
  const files = [
    account("a", { recent_requests: bucketsOf([2, 1], [3, 0]) }),
    account("b", { recent_requests: bucketsOf([1, 0], [0, 0]) }),
    account("c", { provider: "claude", recent_requests: undefined as never }),
  ];
  const usage = {
    openrouter: { "u|k1": { success: 0, failed: 0, recent_requests: bucketsOf([4, 2], [0, 0]) } },
  };
  const t = traffic(files, usage);
  assert.deepEqual(t.accounts, [
    { provider: "codex", buckets: { total: [4, 3], failed: [1, 0] } },
    { provider: "claude", buckets: null },
  ]);
  assert.deepEqual(t.keys, [
    { provider: "openrouter", buckets: { total: [6, 0], failed: [2, 0] } },
  ]);
  assert.deepEqual(t.all, { total: [10, 3], failed: [3, 0] });
  assert.equal(t.max, 10);
  // Nothing reported at all: no total and the strips still get a usable max.
  assert.deepEqual(traffic([account("c", { recent_requests: undefined as never })], null), {
    all: null,
    accounts: [{ provider: "codex", buckets: null }],
    keys: [],
    max: 1,
  });
});

test("success rate: unknown without history, none without requests, else the share that succeeded", () => {
  assert.equal(successRate(null), null);
  assert.deepEqual(successRate({ total: [0, 0], failed: [0, 0] }), {
    total: 0,
    failed: 0,
    rate: null,
  });
  assert.deepEqual(successRate({ total: [6, 2], failed: [2, 0] }), {
    total: 8,
    failed: 2,
    rate: 0.75,
  });
});
