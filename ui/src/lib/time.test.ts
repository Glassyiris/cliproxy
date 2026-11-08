import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadLocale, setLocale } from "./i18n.ts";
import { ago, roughSpan, span } from "./time.ts";

const now = Date.parse("2026-10-02T12:00:00Z");
const at = (ms: number) => new Date(now + ms).toISOString();
const spans = [59_000, 90_000, 125 * 60_000, 3 * 86_400_000];

test("durations round to the unit a reader needs", () => {
  assert.deepEqual(spans.map(span), ["59s", "2m", "2h 5m", "3d"]);
  // Rough keeps one unit and rounds: 13 h 58 min reads as 14h, short spans stay as they are.
  assert.deepEqual([90_000, 838 * 60_000, 125 * 60_000].map(roughSpan), ["2m", "14h", "2h"]);
  assert.equal(ago("not a date", now), "");
  assert.equal(ago(at(-10_000), now), "just now");
  assert.equal(ago(at(-3_600_000), now), "1h ago");
  // Epoch milliseconds (as stored for quota checks) are accepted, not parsed as strings.
  assert.equal(ago(now - 120_000, now), "2m ago");
  // A relative time takes one unit: the largest one span gives.
  assert.equal(ago(now - 125 * 60_000, now), "2h ago");
});

test("durations and ago follow the app locale", async (t) => {
  t.after(() => setLocale("en"));
  await Promise.all([loadLocale("zh-CN"), loadLocale("zh-TW")]);
  setLocale("zh-CN");
  assert.deepEqual(spans.map(span), ["59秒", "2分钟", "2小时5分钟", "3天"]);
  assert.equal(ago(at(-10_000), now), "刚刚");
  assert.equal(ago(now - 120_000, now), "2分钟前");
  setLocale("zh-TW");
  assert.deepEqual(spans.map(span), ["59 秒", "2 分鐘", "2 小時 5 分鐘", "3 天"]);
  assert.equal(ago(at(-10_000), now), "剛剛");
  assert.equal(ago(now - 3 * 86_400_000, now), "3 天前");
});
