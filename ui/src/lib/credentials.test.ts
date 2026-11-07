import { strict as assert } from "node:assert";
import { test } from "node:test";
import { accountRow, buckets, credState, level, sumBuckets } from "./credentials.ts";

const now = Date.parse("2026-10-02T12:00:00Z");
const at = (ms: number) => new Date(now + ms).toISOString();

test("credential state: disabled wins, only live cooldowns count, model cooldowns do not block", () => {
  const cooling = [{ scope: "credential", reason: "quota", retry_at: at(4 * 60_000) }];
  assert.equal(credState({ disabled: true, status: "disabled", cooldowns: cooling }, now).label, "Disabled");
  assert.deepEqual(credState({ status: "active", cooldowns: cooling }, now), { lamp: "warn", label: "Cooling 4m", detail: "", until: now + 4 * 60_000 });
  // An expired retry time is history, not state.
  assert.equal(credState({ status: "active", cooldowns: [{ scope: "credential", retry_at: at(-1000) }] }, now).label, "Ready");
  const model = credState({ status: "active", cooldowns: [{ scope: "model", model_key: "x", retry_at: at(60_000) }] }, now);
  assert.deepEqual([model.lamp, model.label, model.detail], ["ok", "Ready", "1 model cooling"]);
  // Unavailable with a retry time is a cooldown; without one it is a failure.
  assert.equal(credState({ status: "error", unavailable: true, next_retry_after: at(90_000) }, now).label, "Cooling 2m");
  assert.equal(credState({ status: "error", unavailable: true }, now).lamp, "bad");
  assert.equal(credState({ status: "error", status_message: "bad token" }, now).detail, "bad token");
  // A cut stated reset: limited until it, next check at retry_at (or now, when due).
  const cut = credState(
    { status: "active", cooldowns: [{ scope: "credential", retry_at: at(30 * 60_000), recover_at: at(6 * 86_400_000) }] },
    now,
  );
  assert.match(cut.label, /^Limited until .+ · next check in 30m$/);
  const due = credState({ status: "active", cooldowns: [{ scope: "credential", retry_at: at(-1000), recover_at: at(86_400_000) }] }, now);
  assert.match(due.label, /· next check on next request$/);
  assert.equal(due.lamp, "warn");
  // Rust reports cooldowns: null today.
  assert.equal(credState({ status: "active", cooldowns: null }, now).label, "Ready");
  assert.deepEqual(credState({ status: "pending" }, now), { lamp: "off", label: "pending", detail: "" });
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
  assert.equal(credState({ status: "error", status_message: "refresh token was revoked" }, now).label, "Sign in again");
  assert.equal(credState({ status: "error", status_message: "upstream returned 401" }, now).label, "Sign in again");
  assert.equal(credState({ status: "error", status_message: "context window 4010 tokens over" }, now).label, "Error");
  assert.equal(credState({ unavailable: true, status_message: "upstream 503" }, now).label, "Unavailable");
});

test("account rows: status words, honest unknowns, low, last used and weekly order", () => {
  const traffic = (last: number) => Array.from({ length: 20 }, (_, i) => ({ success: i === last ? 2 : 0 }));
  const w = (label: string, used: number, inMs = 3_600_000) => ({ label, used, reset: at(inMs) });
  const checked = (windows: any[], ago = 3 * 60_000) => ({ windows, at: now - ago });
  const row = (a: any, q: any = null, live = true, source = true) => accountRow({ status: "active", ...a }, q, live, source, now);

  // In use only for a ready account with a request in the latest bucket; never for a disabled one.
  assert.deepEqual([row({ recent_requests: traffic(19) }).word, row({ recent_requests: traffic(19) }).sub], ["In use", "serving now"]);
  assert.equal(row({ disabled: true, recent_requests: traffic(19) }).word, "Disabled");
  assert.equal(row({ disabled: true }).sub, "not in rotation");
  assert.equal(row({ recent_requests: traffic(16) }).word, "Ready");
  assert.equal(row({ recent_requests: traffic(16) }).last, "used 30m ago");
  assert.equal(row({ recent_requests: traffic(-1) }).last, "not in 200 min");
  assert.equal(row({}).last, "");

  // Unknown quota says why and is never a number.
  assert.deepEqual(row({}).session, { why: "not checked" });
  assert.deepEqual(row({}, { error: "HTTP 500" }).weekly, { why: "usage read failed" });
  assert.deepEqual(row({}, null, false, false).weekly, { why: "no usage source" });
  assert.deepEqual(row({ disabled: true }, { error: "x" }).session, { why: "not checked" });
  assert.deepEqual(row({}, checked([w("Current session", 40)])).weekly, { why: "not reported" });
  assert.deepEqual(row({}, checked([])).session, { why: "no usage windows reported" });
  assert.equal(row({}).age, "never checked");
  assert.equal(row({ disabled: true }).age, "disabled");

  // The all-models week wins over a scoped one listed first; it orders the rows.
  const claude = row({}, checked([w("Current week (Opus only)", 90, 86_400_000), w("Current session", 20), w("Current week (all models)", 48, 2 * 86_400_000)]));
  assert.deepEqual(claude.weekly, { used: 48, reset: "resets in 2d" });
  assert.equal(claude.next, now + 2 * 86_400_000);
  assert.equal(claude.age, "checked 3m ago");
  assert.equal(row({}, checked([w("Current session", 20)])).next, Infinity);
  const codex = row({}, checked([w("5-hour limit", 91, 47 * 60_000), w("Weekly limit", 63)]), false);
  assert.deepEqual([codex.session, codex.age], [{ used: 91, reset: "resets in 47m" }, "seen 3m ago"]);

  // Plugin windows are recognised by their length; any reported window can make a row Low.
  const plugin = row({}, checked([w("Pro · 5h", 90), w("Pro · 7d", 30), w("Pro · monthly", 95)]));
  assert.deepEqual([plugin.session, plugin.weekly], [{ used: 90, reset: "resets in 1h" }, { used: 30, reset: "resets in 1h" }]);
  assert.deepEqual([plugin.low, plugin.sub], [true, "Pro · monthly 95% used"]);
  // Low: a ready account at 85% or more of either window says which.
  assert.deepEqual([codex.low, codex.sub], [true, "Session 91% used"]);
  assert.equal(row({}, checked([w("Current session", 84.9), w("Weekly limit", 10)])).low, false);
  assert.equal(row({}, checked([w("Current session", 8), w("Weekly limit", 86)])).sub, "Weekly 86% used");
  const cooling = row({ cooldowns: [{ scope: "credential", retry_at: at(20 * 60_000) }] }, checked([w("Current session", 100)]));
  assert.match(cooling.word, /^Cooling until \d/);
  assert.deepEqual([cooling.low, cooling.ready, cooling.attention], [false, false, false]);

  // Sign in again: the last numbers stay, dimmed and dated.
  const refused = row({ status: "error", status_message: "401 unauthorized" }, checked([w("Current session", 41)], 3 * 3_600_000));
  assert.deepEqual([refused.word, refused.sub, refused.stale, refused.attention], ["Sign in again", "token refused", true, true]);
  assert.deepEqual(refused.session, { used: 41, reset: "3h old" });
});
