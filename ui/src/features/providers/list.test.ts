import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entry } from "./groups.ts";
import { countBy, inScope, inView, showOf } from "./list.ts";

const traffic = (total: number, failed: number) => ({
  total: [total],
  failed: [failed],
  times: [""],
});
const entry = (name: string, over: Partial<Entry> = {}): Entry => ({
  family: "claude",
  index: 0,
  group: { name },
  name,
  keys: [{ key: { "api-key": "k" }, traffic: null }],
  traffic: null,
  ...over,
});

const ready = entry("team");
const off = entry("off", { group: { name: "off", disabled: true } });
const empty = entry("empty", { keys: [] });
const failing = entry("down", { keys: [{ key: {}, traffic: traffic(4, 2) }] });
const some = entry("half", {
  family: "codex",
  group: { name: "half", "base-url": "https://relay.example.invalid/v1" },
  keys: [
    { key: {}, traffic: traffic(4, 2) },
    { key: {}, traffic: traffic(4, 0) },
  ],
});
const all = [ready, off, empty, failing, some];

test("showOf names the status the group's lamp shows", () => {
  assert.deepEqual(all.map(showOf), ["ready", "disabled", "noKeys", "failing", "someFailing"]);
});

test("the needs-attention view keeps every group that is not serving in full", () => {
  assert.deepEqual(inView(all, "needs"), [off, empty, failing, some]);
  assert.equal(inView(all, "all").length, 5);
});

test("inScope filters by family, status and a search over name and endpoint", () => {
  assert.deepEqual(inScope(all, { provider: "codex", show: "", search: "" }), [some]);
  assert.deepEqual(inScope(all, { provider: "", show: "disabled", search: "" }), [off]);
  assert.deepEqual(inScope(all, { provider: "", show: "", search: "RELAY v1" }), [some]);
  assert.deepEqual(inScope(all, { provider: "", show: "", search: "team" }), [ready]);
});

test("countBy counts the groups under each key", () => {
  assert.deepEqual(
    [...countBy(all, (e) => e.family)],
    [
      ["claude", 4],
      ["codex", 1],
    ],
  );
});
