import assert from "node:assert/strict";
import { test } from "node:test";
import type { Credential } from "../../lib/api/credentials.ts";
import { fieldPatch, hiddenSelection, matches, reach, toRows, toSwitch, type Row } from "./rows.ts";

const account = (fields: Partial<Credential>) =>
  ({ id: "", auth_index: "", status: "active", ...fields }) as Credential;
const quota = { limits: () => null, isLive: () => false, hasSource: () => false };
const rows = (list: Partial<Credential>[]) => toRows(list.map(account), quota, 0);
const keys = (list: Row[]) => list.map((r) => r.account.auth_index);
const pick = (list: Row[], ...indexes: string[]) =>
  new Set(list.filter((r) => indexes.includes(r.account.auth_index)).map((r) => r.key));

test("search matches every word in the name, email or note, ignoring case", () => {
  const [r] = rows([{ name: "codex-a.json", email: "Ada@example.invalid", note: "team seat" }]);
  assert.equal(matches(r, ""), true);
  assert.equal(matches(r, "ada TEAM"), true);
  assert.equal(matches(r, "codex-a"), true);
  assert.equal(matches(r, "ada backup"), false);
});

test("a batch reaches every account of each file that holds a selected one", () => {
  const list = rows([
    { name: "shared.json", auth_index: "1" },
    { name: "shared.json", auth_index: "2", disabled: true },
    { name: "own.json", auth_index: "3" },
    { name: "config", auth_index: "4", runtime_only: true },
    { name: "config", auth_index: "5", runtime_only: true },
  ]);
  assert.deepEqual(reach(list, pick(list, "1", "4")).map(keys), [["4"], ["1", "2"]]);
});

test("switching reaches only files with a selected account to change, and skips done ones", () => {
  const list = rows([
    { name: "shared.json", auth_index: "1" },
    { name: "shared.json", auth_index: "2", disabled: true },
    { name: "off.json", auth_index: "3", disabled: true },
  ]);
  const selected = pick(list, "1", "3");
  const files = reach(list, selected);
  assert.deepEqual(keys(toSwitch(files, selected, true)), ["1"]);
  assert.deepEqual(keys(toSwitch(files, selected, false)), ["3"]);
});

test("hidden selected accounts are on one other tab or hidden by the filters", () => {
  const [claude, codex, codex2] = rows([
    { name: "a.json", provider: "claude" },
    { name: "b.json", provider: "codex" },
    { name: "c.json", provider: "codex" },
  ]);
  assert.deepEqual(hiddenSelection([claude, codex], [claude], "claude"), {
    count: 1,
    provider: "codex",
  });
  assert.deepEqual(hiddenSelection([codex, codex2], [codex], "codex"), {
    count: 1,
    provider: null,
  });
  assert.deepEqual(hiddenSelection([claude, codex], [claude], ""), { count: 1, provider: null });
});

test("saving fields trims the note and sends null only for a number that was set", () => {
  const a = account({ name: "a.json", priority: 3, note: "x" });
  assert.deepEqual(
    fieldPatch(a, { note: " team ", priority: null, weight: null, request_retry: 2 }),
    { note: "team", priority: null, request_retry: 2 },
  );
});
