import { strict as assert } from "node:assert";
import { test } from "node:test";
import { otherSignals, quotaWindows, signalWindows } from "./quota-windows.ts";


test("quota is percent used, not remaining; unknown payloads stay empty", () => {
  assert.deepEqual(quotaWindows("claude", { five_hour: { utilization: 37, resets_at: "later" }, seven_day: null }), [
    { label: "Current session", used: 37, reset: "later" },
  ]);
  assert.equal(quotaWindows("codex", { rate_limit: { primary_window: { used_percent: 24, reset_at: 1000 } } })[0].used, 24);
  // Codex windows are named by their length; without one, by their slot.
  assert.deepEqual(
    quotaWindows("codex", {
      rate_limit: {
        primary_window: { used_percent: 61, limit_window_seconds: 18000, reset_at: 1790000000 },
        secondary_window: { used_percent: 18, limit_window_seconds: 604800, reset_at: 1790500000 },
      },
    }).map((w) => [w.label, w.used, w.reset]),
    [
      ["5-hour limit", 61, "2026-09-21T14:13:20.000Z"],
      ["Weekly limit", 18, "2026-09-27T09:06:40.000Z"],
    ],
  );
  assert.equal(quotaWindows("codex", { rate_limit: { secondary_window: { used_percent: 3 } } })[0].label, "Secondary limit");
  assert.equal(quotaWindows("x", { groups: [{ displayName: "Pro", buckets: [{ remainingFraction: 0.25 }] }] })[0].used, 75);
  assert.deepEqual(quotaWindows("gemini", {}), []);
});

test("Claude usage: the limits list, as Claude Code titles it", () => {
  // limits[] wins outright: legacy fields alongside it are ignored, rows keep the server's
  // order within each group, a null percentage is dropped, and kinds decide the title.
  const withLimits = {
    limits: [
      { kind: "weekly_all", group: "weekly", percent: 31, resets_at: "2026-07-28T10:00:00+00:00", scope: null, is_active: false },
      { kind: "session", group: "session", percent: 44, resets_at: "2026-07-27T10:00:00+00:00", scope: null, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: 64, resets_at: "2026-07-28T10:00:00+00:00", scope: { model: { id: null, display_name: "Fable" } }, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: null, resets_at: null, scope: { model: { id: null, display_name: "Opus" } }, is_active: false },
      { kind: "session", group: "session", percent: 7, resets_at: null, scope: null, label: "Current week (all models)" },
    ],
    five_hour: { utilization: 99, resets_at: null },
    seven_day_opus: { utilization: 88, resets_at: null },
    iguana_necktie: { utilization: 64, resets_at: null },
    extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 1250, utilization: 12.5, currency: "USD" },
  };
  assert.deepEqual(quotaWindows("claude", withLimits), [
    { label: "Current week (all models)", used: 31, reset: "2026-07-28T10:00:00+00:00" },
    { label: "Current week (Fable only)", used: 64, reset: "2026-07-28T10:00:00+00:00" },
    { label: "Current session", used: 44, reset: "2026-07-27T10:00:00+00:00" },
    { label: "Current session", used: 7, reset: "" },
    { label: "Extra usage", used: 12.5, reset: "", detail: "$12.50 of $100.00" },
  ]);
});

test("Claude usage: legacy buckets when there is no limits list", () => {
  assert.deepEqual(
    quotaWindows("claude", {
      five_hour: { utilization: 12.0, resets_at: "2026-05-03T06:50Z" },
      seven_day: { utilization: 70.0, resets_at: "2026-05-04T00:00Z" },
      seven_day_sonnet: { utilization: 38.0, resets_at: "2026-05-04T00:00Z" },
      seven_day_opus: { utilization: 0, resets_at: "2026-05-04T00:00Z" },
      cinder_cove: { utilization: 5, resets_at: null },
      extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 300, utilization: null, currency: "USD" },
    }),
    [
      { label: "Current session", used: 12, reset: "2026-05-03T06:50Z" },
      { label: "Current week (all models)", used: 70, reset: "2026-05-04T00:00Z" },
      { label: "Current week (Sonnet only)", used: 38, reset: "2026-05-04T00:00Z" },
      // A real 0 is a real 0%; only null is hidden.
      { label: "Current week (Opus only)", used: 0, reset: "2026-05-04T00:00Z" },
      { label: "Other limit", used: 5, reset: "" },
      { label: "Extra usage", used: null, reset: "", detail: "$3.00 spent, no limit" },
    ],
  );
});

test("Claude usage: placeholders and skipped buckets never show, null is never 0%", () => {
  const placeholders = {
    five_hour: { utilization: 23.0, resets_at: "2026-05-03T06:50Z" },
    seven_day: { utilization: null, resets_at: null },
    seven_day_sonnet: null,
    seven_day_opus: null,
    seven_day_omelette: { utilization: 100.0, resets_at: "2026-05-04T00:00Z" },
    seven_day_oauth_apps: { utilization: 3, resets_at: null },
    seven_day_cowork: { utilization: 9, resets_at: null },
    tangelo: null,
    iguana_necktie: { utilization: 0, resets_at: null },
    omelette_promotional: null,
    cinder_cove: null,
    extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 100, utilization: 2 },
  };
  assert.deepEqual(quotaWindows("claude", placeholders), [{ label: "Current session", used: 23, reset: "2026-05-03T06:50Z" }]);
  assert.deepEqual(quotaWindows("claude", { tangelo: null, iguana_necktie: null, omelette_promotional: null, limits: [] }), []);
});

test("passive limits from Codex headers and Devin quota", () => {
  const observed = "2026-10-02T12:00:00Z";
  const codex = signalWindows("codex", {
    observed_at: observed,
    signals: {
      "X-Codex-Primary-Used-Percent": "42.5",
      "X-Codex-Primary-Window-Minutes": "300",
      "X-Codex-Primary-Reset-At": String(Date.parse("2026-10-02T14:00:00Z") / 1000),
      "x-codex-secondary-used-percent": "7",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-after-seconds": "3600",
      "x-codex-code-review-primary-used-percent": "99",
    },
  });
  assert.deepEqual(codex, [
    { label: "5-hour limit", used: 42.5, reset: "2026-10-02T14:00:00.000Z", source: "x-codex-primary-" },
    // Relative resets count from when the server observed them, not from now.
    { label: "Weekly limit", used: 7, reset: "2026-10-02T13:00:00.000Z", source: "x-codex-secondary-" },
  ]);
  assert.deepEqual(signalWindows("codex", { signals: { "x-codex-primary-window-minutes": "300" } }), []);
  assert.deepEqual(
    signalWindows("devin", { signals: { daily_quota_remaining_percent: "87%", weekly_quota_remaining_percent: "100%", daily_quota_reset_at: "2026-10-03T00:00:00Z" } }),
    [
      { label: "Daily", used: 13, reset: "2026-10-03T00:00:00Z", source: "daily_quota_" },
      { label: "Weekly", used: 0, reset: "", source: "weekly_quota_" },
    ],
  );
  assert.deepEqual(signalWindows("claude", { signals: { "x-codex-primary-used-percent": "5" } }), []);
  // Claude's unified headers, as recorded: fractions of 1 and Unix-second resets.
  const claude = {
    signals: {
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.07",
      "Anthropic-Ratelimit-Unified-5h-Reset": String(Date.parse("2026-10-02T15:00:00Z") / 1000),
      "anthropic-ratelimit-unified-7d-utilization": "0.634",
      "anthropic-ratelimit-unified-7d-reset": String(Date.parse("2026-10-06T09:00:00Z") / 1000),
      "anthropic-ratelimit-unified-overage-utilization": "0.25",
      "anthropic-ratelimit-unified-overage-status": "allowed",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
    },
  };
  assert.deepEqual(signalWindows("claude", claude), [
    { label: "Current session", used: 7, reset: "2026-10-02T15:00:00.000Z", source: "anthropic-ratelimit-unified-5h-" },
    { label: "Current week (all models)", used: 63.4, reset: "2026-10-06T09:00:00.000Z", source: "anthropic-ratelimit-unified-7d-" },
    { label: "Extra usage", used: 25, reset: "", source: "anthropic-ratelimit-unified-overage-" },
  ]);
  assert.deepEqual(otherSignals(claude, signalWindows("claude", claude)).map(([k]) => k), ["anthropic-ratelimit-unified-representative-claim"]);
  const off = { signals: { "anthropic-ratelimit-unified-overage-utilization": "0", "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled" } };
  assert.deepEqual(signalWindows("claude", off), []);
  // Malformed headers are not readings: no partial parse, no infinity, no thrown RangeError.
  const bad = (u: string, r: string) => signalWindows("claude", { signals: { "anthropic-ratelimit-unified-5h-utilization": u, "anthropic-ratelimit-unified-5h-reset": r } });
  assert.deepEqual(bad("0.5junk", "1793474400"), []);
  assert.deepEqual(bad("Infinity", "1793474400"), []);
  assert.deepEqual(bad("", "1793474400"), []);
  assert.deepEqual(bad(" ", "1793474400"), []);
  assert.deepEqual(bad("0.3", "Infinity"), [{ label: "Current session", used: 30, reset: "", source: "anthropic-ratelimit-unified-5h-" }]);
  assert.deepEqual(bad("0.3", "1e300"), [{ label: "Current session", used: 30, reset: "", source: "anthropic-ratelimit-unified-5h-" }]);
  assert.deepEqual(bad("0.3", "17934744junk"), [{ label: "Current session", used: 30, reset: "", source: "anthropic-ratelimit-unified-5h-" }]);
});

test("signals not drawn as a window stay visible", () => {
  const quota = {
    signals: {
      "X-Codex-Primary-Used-Percent": "40",
      "x-codex-primary-window-minutes": "300",
      // No used percent, so no secondary window: its reset must stay visible.
      "x-codex-secondary-reset-at": "1790000000",
      "x-codex-code-review-primary-used-percent": "100",
      "x-codex-credits-balance": "5",
      "retry-after": "30",
    },
  };
  const keys = (w: ReturnType<typeof signalWindows>) => otherSignals(quota, w).map(([k]) => k);
  assert.deepEqual(keys(signalWindows("codex", quota)), [
    "x-codex-secondary-reset-at",
    "x-codex-code-review-primary-used-percent",
    "x-codex-credits-balance",
    "retry-after",
  ]);
  // Windows from a live check carry no source, so every signal shows beside them.
  assert.equal(keys([{ label: "5-hour", used: 1, reset: "" }]).length, 6);
});
