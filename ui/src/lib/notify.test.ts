import { strict as assert } from "node:assert";
import { test } from "node:test";
import { notify, onNotice, placement } from "./notify.ts";

test("each level goes where DESIGN.md Notifications puts it", () => {
  assert.deepEqual(placement("success"), { surface: "toast", type: "info", autoHide: true });
  assert.deepEqual(placement("info"), { surface: "toast", type: "info", autoHide: true });
  assert.deepEqual(placement("warning"), { surface: "banner" });
  // A failed action stays until the user dismisses it.
  assert.deepEqual(placement("error"), { surface: "toast", type: "error", autoHide: false });
});

test("notify reaches every subscriber until it unsubscribes", () => {
  const seen: string[] = [];
  const stop = onNotice((n) => seen.push(`${n.level}:${n.message}`));
  notify("warning", "cooling");
  stop();
  notify("error", "after");
  assert.deepEqual(seen, ["warning:cooling"]);
});
