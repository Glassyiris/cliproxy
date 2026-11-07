import { strict as assert } from "node:assert";
import { test } from "node:test";
import { equal } from "./compare.ts";
import { fieldPath } from "./config-path.ts";

test("v8 paths, URL boundaries, and structural equality", () => {
  assert.throws(() => fieldPath("oauth/../key"));
  assert.equal(fieldPath("plugins/configs/my plugin"), "/config/plugins/configs/my%20plugin");
  assert.equal(equal({ b: null, a: [1, false] }, { a: [1, false], b: null }), true);
  assert.equal(equal({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(equal({ a: false }, { a: null }), false);
});
