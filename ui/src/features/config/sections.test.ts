import assert from "node:assert/strict";
import { test } from "node:test";
import { isKnown, sectionNames, summarize } from "./sections.ts";

test("sectionNames lists the known sections first, then other keys, never config-version", () => {
  const names = sectionNames({ "config-version": 8, zeta: 1, routing: {}, alpha: {} });
  assert.equal(names.length, 13);
  assert.deepEqual(names.slice(0, 3), ["server", "management", "access"]);
  assert.deepEqual(names.slice(-2), ["zeta", "alpha"]);
  assert.equal(names.includes("config-version"), false);
});

test("isKnown separates the sections the page describes from the rest", () => {
  assert.equal(isKnown("api-keys"), true);
  assert.equal(isKnown("zeta"), false);
});

test("summarize tells an unset section, a container and a plain value apart", () => {
  assert.deepEqual(summarize(undefined), { kind: "default" });
  assert.deepEqual(summarize({ a: 1, b: 2 }), { kind: "count", count: 2 });
  assert.deepEqual(summarize([]), { kind: "count", count: 0 });
  assert.deepEqual(summarize(false), { kind: "value", text: "false" });
  assert.deepEqual(summarize(null), { kind: "value", text: "null" });
});
