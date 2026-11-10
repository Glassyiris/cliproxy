import { strict as assert } from "node:assert";
import { test } from "node:test";
import { equal } from "./compare.ts";
import { absent, configPath, storedValue } from "./configPath.ts";

test("config paths stay literal in JSON and reject empty or traversal segments", () => {
  for (const path of ["", "/oauth", "oauth/", "oauth//key", "oauth/../key", "a/./b", "a\\b"])
    assert.throws(() => configPath(path), /Invalid configuration path/);
  assert.equal(configPath("plugins/configs/my plugin"), "plugins/configs/my plugin");
  assert.equal(configPath("plugins/configs/百分比%"), "plugins/configs/百分比%");
});

test("stored values distinguish a missing key from null and ignore inherited properties", () => {
  assert.equal(storedValue({ access: { key: null } }, "access/key"), null);
  assert.equal(storedValue({ access: null }, "access/key"), absent);
  assert.equal(storedValue({}, "toString"), absent);
});

test("structural equality preserves order and distinguishes null from false", () => {
  assert.equal(equal({ b: null, a: [1, false] }, { a: [1, false], b: null }), true);
  assert.equal(equal({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(equal({ a: false }, { a: null }), false);
});
