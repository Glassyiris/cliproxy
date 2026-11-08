import { strict as assert } from "node:assert";
import { test } from "node:test";
import { accountRow, buckets, credName, credState, level, sumBuckets, type Bar, type Limits } from "./credentials.ts";
import type { Window, WindowLabel } from "./quotaWindows.ts";

const now = Date.parse("2026-10-02T12:00:00Z");
const at = (ms: number) => new Date(now + ms).toISOString();

test("credential state: disabled wins, only live cooldowns count, model cooldowns do not block", () => {
  const cooling = [{ scope: "credential", reason: "quota", retry_at: at(4 * 60_000) }];
  assert.equal(credState({ disabled: true, status: "disabled", cooldowns: cooling }, now).state, "disabled");
  assert.deepEqual(credState({ status: "active", cooldowns: cooling }, now), { lamp: "warn", state: "cooling", detail: "", until: now + 4 * 60_000 });
  // An expired retry time is history, not state.
  assert.equal(credState({ status: "active", cooldowns: [{ scope: "credential", retry_at: at(-1000) }] }, now).state, "ready");
  const model = credState({ status: "active", cooldowns: [{ scope: "model", model_key: "x", retry_at: at(60_000) }] }, now);
  assert.deepEqual([model.lamp, model.state, model.modelsCooling], ["ok", "ready", 1]);
  // Unavailable with a retry time is a cooldown; without one it is a failure.
  const unavailable = credState({ status: "error", unavailable: true, next_retry_after: at(90_000) }, now);
  assert.deepEqual([unavailable.state, unavailable.until], ["cooling", now + 90_000]);
  assert.equal(credState({ status: "error", unavailable: true }, now).lamp, "bad");
  assert.equal(credState({ status: "error", status_message: "bad token" }, now).detail, "bad token");
  // A cut stated reset: limited until it, next check at retry_at (or on the next request, when due).
  const cut = credState(
    { status: "active", cooldowns: [{ scope: "credential", retry_at: at(30 * 60_000), recover_at: at(6 * 86_400_000) }] },
    now,
  );
  assert.deepEqual([cut.state, cut.until, cut.nextCheck], ["limited", now + 6 * 86_400_000, now + 30 * 60_000]);
  const due = credState({ status: "active", cooldowns: [{ scope: "credential", retry_at: at(-1000), recover_at: at(86_400_000) }] }, now);
  assert.deepEqual([due.state, due.nextCheck, due.lamp], ["limited", null, "warn"]);
  // Rust reports cooldowns: null today.
  assert.equal(credState({ status: "active", cooldowns: null }, now).state, "ready");
  assert.deepEqual(credState({ status: "pending" }, now), { lamp: "off", state: "other", status: "pending", detail: "", modelsCooling: 0 });
});

test("traffic buckets: absent history stays absent; sums align to the newest bucket", () => {
  assert.equal(buckets({ name: "rust.json" }), null);
  assert.equal(sumBuckets([null, null]), null);
  const a = buckets({ recent_requests: [{ success: 1 }, { success: 2, failed: 1 }, { success: 3 }] });
  const b = buckets({ recent_requests: [{ success: 10 }, { failed: 20 }] });
  assert.deepEqual(a, { total: [1, 3, 3], failed: [0, 1, 0] });
  assert.deepEqual(sumBuckets([a, null, b]), { total: [1, 13, 23], failed: [0, 1, 20] });
});

test("grille levels: zero is dark, any traffic is visible, the peak is full", () => {
  assert.deepEqual([0, 1, 50, 51, 100].map((n) => level(n, 100)), [0, 1, 2, 3, 4]);
  assert.equal(level(5, 0), 0);
});

test("expired sign-ins ask for a new sign-in; other errors stay errors", () => {
  assert.equal(credState({ status: "error", status_message: "refresh token was revoked" }, now).state, "signIn");
  assert.equal(credState({ status: "error", status_message: "upstream returned 401" }, now).state, "signIn");
  assert.equal(credState({ status: "error", status_message: "context window 4010 tokens over" }, now).state, "error");
  assert.equal(credState({ unavailable: true, status_message: "upstream 503" }, now).state, "unavailable");
});

test("account rows: status words, honest unknowns, low, last used and weekly order", () => {
  const traffic = (last: number) => Array.from({ length: 20 }, (_, i) => ({ success: i === last ? 2 : 0 }));
  const w = (label: WindowLabel, used: number, inMs = 3_600_000) => ({ label, used, reset: at(inMs) });
  const session = { name: "session" } as const;
  const checked = (windows: Window[], ago = 3 * 60_000) => ({ windows, at: now - ago });
  const row = (a: object, q: Limits = null, live = true, source = true) =>
    accountRow({ status: "active", ...a }, q, live, source, now);
  const used = (bar: Bar) => ("window" in bar ? [bar.window.used, bar.staleFor] : bar.why);

  // In use only for a ready account with a request in the latest bucket; never for a disabled one.
  const serving = row({ recent_requests: traffic(19) });
  assert.deepEqual([serving.serving, serving.word, serving.sub], [true, { kind: "inUse" }, { kind: "serving" }]);
  assert.deepEqual(row({ disabled: true, recent_requests: traffic(19) }).word, { kind: "state" });
  assert.deepEqual(row({ disabled: true }).sub, { kind: "notInRotation" });
  assert.deepEqual(row({ recent_requests: traffic(16) }).last, { kind: "ago", ms: 30 * 60_000 });
  assert.deepEqual(row({ recent_requests: traffic(19) }).last, { kind: "now" });
  assert.deepEqual(row({ recent_requests: traffic(-1) }).last, { kind: "notIn", minutes: 200 });
  assert.equal(row({}).last, null);

  // Unknown quota says why and is never a number.
  assert.equal(used(row({}).session), "notChecked");
  assert.equal(used(row({}, { error: { reason: "status", status: 500 } }).weekly), "readFailed");
  assert.equal(used(row({}, null, false, false).weekly), "noSource");
  assert.equal(used(row({ disabled: true }, { error: { reason: "failed", detail: "x" } }).session), "notChecked");
  assert.equal(used(row({}, checked([w(session, 40)])).weekly), "notReported");
  assert.equal(used(row({}, checked([])).session), "noWindows");
  assert.deepEqual(row({}).age, { kind: "never" });
  assert.deepEqual(row({ disabled: true }).age, { kind: "disabled" });

  // The all-models week wins over a scoped one listed first; it orders the rows.
  const claude = row({}, checked([w({ name: "weekModel", model: "Opus" }, 90, 86_400_000), w(session, 20), w({ name: "weekAll" }, 48, 2 * 86_400_000)]));
  assert.deepEqual(used(claude.weekly), [48, null]);
  assert.equal(claude.next, now + 2 * 86_400_000);
  assert.deepEqual(claude.age, { kind: "checked", at: now - 3 * 60_000 });
  assert.equal(row({}, checked([w(session, 20)])).next, Infinity);
  const codex = row({}, checked([w({ name: "fiveHourLimit" }, 91, 47 * 60_000), w({ name: "weeklyLimit" }, 63)]), false);
  assert.deepEqual([used(codex.session), codex.age], [[91, null], { kind: "seen", at: now - 3 * 60_000 }]);
  // A Codex window of another length is weekly when it is about a week long.
  const week = row({}, checked([w({ name: "lengthLimit", seconds: 7 * 86_400 + 3600 }, 12)]));
  assert.deepEqual(used(week.weekly), [12, null]);

  // Plugin windows are recognised by their length; any reported window can make a row Low.
  const plugin = row({}, checked([w({ text: "Pro · 5h" }, 90), w({ text: "Pro · 7d" }, 30), w({ text: "Pro · monthly" }, 95)]));
  assert.deepEqual([used(plugin.session), used(plugin.weekly)], [[90, null], [30, null]]);
  assert.deepEqual([plugin.low, plugin.sub], [true, { kind: "low", window: { text: "Pro · monthly" }, used: 95 }]);
  // Low: a ready account at 85% or more of either window says which.
  assert.deepEqual([codex.low, codex.sub], [true, { kind: "low", window: "session", used: 91 }]);
  assert.equal(row({}, checked([w(session, 84.9), w({ name: "weeklyLimit" }, 10)])).low, false);
  assert.deepEqual(row({}, checked([w(session, 8), w({ name: "weeklyLimit" }, 86)])).sub, { kind: "low", window: "weekly", used: 86 });
  assert.deepEqual(row({}, checked([w(session, 8)])).sub, { kind: "canServe" });
  // A Low row reads Low with the warning lamp and keeps its line while serving.
  const busyLow = row({ recent_requests: traffic(19) }, checked([w(session, 92)]));
  assert.deepEqual([busyLow.word, busyLow.lamp, busyLow.ready, busyLow.serving, busyLow.sub], [{ kind: "low" }, "warn", true, true, { kind: "low", window: "session", used: 92 }]);
  const cooling = row({ cooldowns: [{ scope: "credential", retry_at: at(20 * 60_000) }] }, checked([w(session, 100)]));
  assert.deepEqual(cooling.word, { kind: "coolingUntil", until: now + 20 * 60_000 });
  assert.deepEqual(cooling.sub, { kind: "coolingDown" });
  assert.deepEqual([cooling.low, cooling.ready, cooling.attention], [false, false, false]);

  // Sign in again: the last numbers stay, marked with their age.
  const refused = row({ status: "error", status_message: "401 unauthorized" }, checked([w(session, 41)], 3 * 3_600_000));
  assert.deepEqual([refused.state.state, refused.sub, refused.stale, refused.attention], ["signIn", { kind: "tokenRefused" }, true, true]);
  assert.deepEqual(used(refused.session), [41, 3 * 3_600_000]);
});

test("credential name: a provider key is masked, never shown in full", () => {
  const key = "sk-ant-api03-0123456789abcdef";
  assert.equal(credName({ account_type: "api_key", account: key, name: "claude-key.json" }), "sk-…cdef");
  assert.equal(credName({ account_type: "oauth", account: "me@example.com", name: "x.json" }), "me@example.com");
  assert.equal(credName({ account_type: "api_key", label: "Team key", account: key }), "Team key");
});
