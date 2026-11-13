import { strict as assert } from "node:assert";
import { test } from "node:test";
import { strategy } from "./routing.ts";

test("routing strategy values follow the server's parsing", () => {
  assert.equal(strategy("fill-first"), "fill-first");
  assert.equal(strategy(" FF "), "fill-first");
  assert.equal(strategy("wrr"), "weighted-round-robin");
  assert.equal(strategy("reset-first"), "soonest-reset");
  assert.equal(strategy("random"), "round-robin");
  // Unset is soonest reset on cooker.
  for (const unset of [undefined, null, "", " "]) assert.equal(strategy(unset), "soonest-reset");
});
