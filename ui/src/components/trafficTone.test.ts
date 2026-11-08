import { strict as assert } from "node:assert";
import { test } from "node:test";
import { bucketTone, toneCounts } from "./trafficTone.ts";

test("a bucket's tone follows the share of its requests that failed", () => {
  assert.equal(bucketTone(0, 0), "neutral");
  assert.equal(bucketTone(100, 0), "neutral");
  assert.equal(bucketTone(100, 4), "neutral");
  assert.equal(bucketTone(100, 5), "degraded");
  assert.equal(bucketTone(100, 49), "degraded");
  assert.equal(bucketTone(100, 50), "failing");
  assert.equal(bucketTone(1, 1), "failing");
  assert.equal(bucketTone(0, 3), "failing");
});

test("the summary counts degraded and failing buckets", () => {
  assert.deepEqual(toneCounts([100, 100, 10, 0, 20], [1, 10, 9, 0, 0]), {
    degraded: 1,
    failing: 1,
  });
});
