import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lineDiff, reconcile } from "./compare.ts";

test("diff keeps both sides of a change", () => {
  const diff = lineDiff("same\nold\nend", "same\nnew\nextra\nend");
  assert.deepEqual(
    diff.filter((l) => l.kind !== "added").map((l) => l.text),
    ["same", "old", "end"],
  );
  assert.deepEqual(
    diff.filter((l) => l.kind !== "removed").map((l) => l.text),
    ["same", "new", "extra", "end"],
  );
});

test("reconcile keeps unchanged rows by identity", () => {
  const prev = [
    { name: "a", n: 1 },
    { name: "b", n: 1 },
  ];
  const next = reconcile(
    prev,
    [
      { name: "a", n: 1 },
      { name: "b", n: 2 },
      { name: "c", n: 0 },
    ],
    (v) => v.name,
  );
  assert.equal(next[0], prev[0]);
  assert.notEqual(next[1], prev[1]);
  assert.equal(next.length, 3);
});
