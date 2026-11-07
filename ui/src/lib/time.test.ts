import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ago, span } from "./time.ts";

const now = Date.parse("2026-10-02T12:00:00Z");
const at = (ms: number) => new Date(now + ms).toISOString();

test("durations round to the unit a reader needs", () => {
  assert.deepEqual([59_000, 90_000, 125 * 60_000, 3 * 86_400_000].map(span), ["59s", "2m", "2h 5m", "3d"]);
  assert.equal(ago("not a date", now), "");
  assert.equal(ago(at(-10_000), now), "just now");
  assert.equal(ago(at(-3_600_000), now), "1h ago");
  // Epoch milliseconds (as stored for quota checks) are accepted, not parsed as strings.
  assert.equal(ago(now - 120_000, now), "2m ago");
});
