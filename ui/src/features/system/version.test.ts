import { strict as assert } from "node:assert";
import { test } from "node:test";
import { releaseStatus } from "./version.ts";

test("a newer release is available; the same or an older one is current", () => {
  assert.equal(releaseStatus("v0.4.1", "cliproxy-rs-0.4.0"), "available");
  assert.equal(releaseStatus("v0.10.0", "cliproxy-rs-0.9.9"), "available");
  assert.equal(releaseStatus("v0.4.0", "cliproxy-rs-0.4.0"), "current");
  assert.equal(releaseStatus("0.4", "cliproxy-rs/0.4.0"), "current");
  assert.equal(releaseStatus("v0.3.9", "cliproxy-rs-0.4.0"), "current");
  assert.equal(releaseStatus("v1.0.0", "1.0.0"), "current");
});

test("a missing or non-numeric version cannot be compared", () => {
  assert.equal(releaseStatus("", ""), "unknown");
  assert.equal(releaseStatus("v0.4.0", ""), "unknown");
  assert.equal(releaseStatus("", "cliproxy-rs-0.4.0"), "unknown");
  assert.equal(releaseStatus("v0.5.0-rc1", "cliproxy-rs-0.4.0"), "unknown");
  assert.equal(releaseStatus("v0.5.0", "dev"), "unknown");
  assert.equal(releaseStatus("latest", "cliproxy-rs-0.4.0"), "unknown");
});
