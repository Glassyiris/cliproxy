import { strict as assert } from "node:assert";
import { test } from "node:test";
import { strategy } from "./routing.ts";

test("routing strategy names follow the server's parsing", () => {
  for (const rust of [true, false]) {
    assert.equal(strategy("fill-first", rust).name, "Fill first");
    assert.equal(strategy(" FF ", rust).value, "fill-first");
    assert.equal(strategy("wrr", rust).value, "weighted-round-robin");
    assert.equal(strategy("reset-first", rust).value, "soonest-reset");
    assert.equal(strategy("random", rust).value, "round-robin");
  }
  assert.equal(strategy("soonest-reset", true).rust, true);
  // Unset is soonest reset on cliproxy-rs and round robin on Go.
  for (const unset of [undefined, "", " "]) {
    assert.equal(strategy(unset, true).value, "soonest-reset");
    assert.equal(strategy(unset, false).value, "round-robin");
  }
});
