import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeServer } from "./fakeServer.testSupport.ts";
fakeServer();
const { ConfigChangedError } = await import("./config.ts");
const { removeConfirmed } = await import("./configRemoval.ts");

test("removal refuses a shifted model exclusion, alias, or payload rule", () => {
  for (const [b, c] of [
    ["B", "C"],
    [
      { name: "B", alias: "b" },
      { name: "C", alias: "c" },
    ],
    [{ models: ["B"] }, { models: ["C"] }],
  ]) {
    assert.throws(() => removeConfirmed([b, c], 1, b, "rules"), ConfigChangedError);
    assert.deepEqual(removeConfirmed([c, b], 1, structuredClone(b), "rules"), [c]);
    assert.throws(() => removeConfirmed([], 1, b, "rules"), ConfigChangedError);
  }
});
