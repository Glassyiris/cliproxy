import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fieldCount,
  groupByModel,
  isList,
  isRule,
  modelsOf,
  NO_MODEL,
  parseParams,
  rulesOf,
  storedRules,
  UNREADABLE,
} from "./rules.ts";

test("a filter takes a list and every other kind takes an object", () => {
  assert.deepEqual(parseParams("filter", '["a.b"]'), { value: ["a.b"] });
  assert.deepEqual(parseParams("filter", '{"a":1}'), { error: "notList" });
  assert.deepEqual(parseParams("override", '{"a":1}'), { value: { a: 1 } });
  assert.deepEqual(parseParams("default-raw", "[1]"), { error: "notObject" });
  assert.deepEqual(parseParams("default", "null"), { error: "notObject" });
});

test("text that is not JSON is invalid for every kind", () => {
  assert.deepEqual(parseParams("filter", "["), { error: "invalid" });
  assert.deepEqual(parseParams("default", ""), { error: "invalid" });
});

test("a kind the file lacks is the empty list and null stays null", () => {
  assert.deepEqual(storedRules({}, "default"), []);
  assert.deepEqual(
    storedRules({ requests: { payload: { override: [{ params: {} }] } } }, "default"),
    [],
  );
  assert.equal(storedRules({ requests: { payload: { default: null } } }, "default"), null);
  assert.deepEqual(rulesOf(null), []);
});

test("entries that are not objects keep their place in the list", () => {
  const stored = [{ params: {} }, null, "text", 3, [1]];
  assert.equal(rulesOf(stored).length, 5);
  assert.deepEqual(rulesOf(stored).map(isRule), [true, false, false, false, false]);
  assert.deepEqual(rulesOf({ params: {} }), []);
});

test("a model entry that is not an object shows as its JSON and nothing throws", () => {
  assert.deepEqual(modelsOf({ models: [{ name: "gpt-5*", protocol: "codex" }, { name: "a" }] }), [
    { name: "gpt-5*", protocol: "codex" },
    { name: "a" },
  ]);
  assert.deepEqual(
    modelsOf({ models: [null, "x", {}] }).map((m) => m.name),
    ["null", '"x"', ""],
  );
  assert.deepEqual(modelsOf({ models: "gpt" }), []);
  assert.deepEqual(modelsOf({}), []);
});

test("rules group by model name, a two-model rule under both, keeping each entry's place", () => {
  const groups = groupByModel([
    { kind: "default", entries: [{ models: [{ name: "a" }, { name: "b" }], params: { x: 1 } }] },
    {
      kind: "filter",
      entries: [{ models: [{ name: "a", protocol: "gemini" }] }, 7, { params: [] }],
    },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.name, g.rows.map((r) => r.key)]),
    [
      ["a", ["default:0", "filter:0"]],
      ["b", ["default:0"]],
      [UNREADABLE, ["filter:1"]],
      [NO_MODEL, ["filter:2"]],
    ],
  );
  assert.deepEqual(groups[0].rows[1].model, { name: "a", protocol: "gemini" });
});

test("fieldCount counts an object's paths and a filter's entries", () => {
  assert.equal(fieldCount({ a: 1, b: 2 }), 2);
  assert.equal(fieldCount(["a"]), 1);
  assert.equal(fieldCount(null), 0);
  assert.equal(fieldCount("x"), 0);
});

test("only an object, string or number stored for a kind counts as not a list", () => {
  assert.equal(isList([]), true);
  assert.equal(isList(null), true);
  assert.equal(isList({ models: [] }), false);
  assert.equal(isList("text"), false);
  assert.equal(isList(7), false);
});
