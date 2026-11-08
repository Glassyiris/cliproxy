import assert from "node:assert/strict";
import { test } from "node:test";
import type { Credential } from "../../lib/api/credentials.ts";
import {
  countBy,
  fieldPatch,
  fieldsOf,
  pruneSelection,
  hasShow,
  hiddenSelection,
  inScope,
  inView,
  matches,
  reach,
  shows,
  toRows,
  toSwitch,
  type Row,
} from "./rows.ts";

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
    fieldPatch(fieldsOf(a), { note: " team ", priority: null, weight: null, request_retry: 2 }),
    { note: "team", priority: null, request_retry: 2 },
  );
});

test("the default view keeps accounts that cannot serve; a status narrows to that state", () => {
  const list = rows([
    { name: "ok.json", auth_index: "1" },
    { name: "off.json", auth_index: "2", disabled: true },
    { name: "bad.json", auth_index: "3", status: "error", status_message: "HTTP 401" },
  ]);
  const scope = inScope(list, { provider: "", show: "", search: "" });
  assert.deepEqual(keys(inView(scope, "needs")).sort(), ["2", "3"]);
  assert.equal(inView(scope, "all").length, 3);
  assert.deepEqual(keys(inScope(list, { provider: "", show: "signIn", search: "" })), ["3"]);
  assert.deepEqual(keys(inScope(list, { provider: "", show: "ready", search: "" })), ["1"]);
});

test("the status options partition the accounts: a Low account is not also Ready", () => {
  const used = { "1": 90, "2": 40 } as Record<string, number>;
  const limits = (a: Credential) =>
    a.auth_index in used
      ? {
          windows: [{ label: { name: "session" as const }, used: used[a.auth_index], reset: "" }],
          at: 1,
        }
      : null;
  const files: Partial<Credential>[] = [
    { name: "low.json", auth_index: "1" },
    { name: "ok.json", auth_index: "2" },
    { name: "off.json", auth_index: "3", disabled: true },
    { name: "bad.json", auth_index: "4", status: "error", status_message: "HTTP 401" },
  ];
  const list = toRows(files.map(account), { ...quota, limits }, 0);
  const counts = countBy(list, shows, hasShow);
  assert.equal(
    [...counts.values()].reduce((a, b) => a + b, 0),
    list.length,
  );
  assert.deepEqual([counts.get("ready"), counts.get("low")], [1, 1]);
  const low = list.find((r) => r.account.auth_index === "1")!;
  // Low still serves: it is not in the needs view, and its row reads the filter's word.
  assert.deepEqual([low.view.ready, low.view.lamp, low.view.word], [true, "warn", { kind: "low" }]);
  assert.deepEqual(keys(inView(list, "needs")).sort(), ["3", "4"]);
});

test("selection drops disappeared accounts but keeps rows hidden by filters", () => {
  const [runtime, hidden] = rows([
    { name: "a", auth_index: "1", runtime_only: true },
    { name: "b", auth_index: "2", provider: "claude" },
  ]);
  assert.equal(inScope([hidden], { provider: "codex", show: "", search: "" }).length, 0);
  const selected = new Set([runtime.key, hidden.key]);
  const pruned = pruneSelection([hidden], selected);
  assert.deepEqual([...pruned], [hidden.key]);
  assert.equal(pruneSelection([hidden], pruned), pruned);
  assert.equal(pruneSelection([], pruned).size, 0);
});

test("saving a note sends only fields changed from the form snapshot", () => {
  const saved = fieldsOf(account({ note: "old", priority: 3, weight: 2, request_retry: 1 }));
  assert.deepEqual(fieldPatch(saved, { ...saved, note: " team " }), { note: "team" });
  assert.deepEqual(fieldPatch(saved, { ...saved, priority: null }), { priority: null });
  assert.deepEqual(fieldPatch(saved, { ...saved, weight: 0 }), { weight: 0 });
  assert.deepEqual(fieldPatch(saved, { ...saved, note: " old " }), {});
  assert.deepEqual(fieldPatch(saved, saved), {});
  const submitted = { ...saved, note: " team " };
  assert.deepEqual(fieldPatch(submitted, { ...submitted, priority: 4 }), { priority: 4 });
});
