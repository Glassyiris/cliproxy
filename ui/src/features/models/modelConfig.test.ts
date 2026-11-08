import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aliasProblems,
  isExcluded,
  kilo,
  matchesQuery,
  modelRows,
  newAlias,
  pageOf,
  readList,
  ruleRows,
  wildcard,
} from "./modelConfig.ts";

test("readList reads a stored null and a missing key as the empty list", () => {
  const config = {
    oauth: { "model-alias": { claude: null, codex: [{ name: "a", alias: "b" }] } },
  };
  assert.deepEqual(readList(config, "model-alias", "claude"), []);
  assert.deepEqual(readList(config, "model-alias", "codex"), [{ name: "a", alias: "b" }]);
  assert.deepEqual(readList(config, "model-alias", "kimi"), []);
  assert.deepEqual(readList(config, "excluded-models", "claude"), []);
  assert.deepEqual(readList({ oauth: null }, "model-alias", "claude"), []);
  assert.deepEqual(readList({}, "model-alias", "claude"), []);
});

test("an alias sets fork only when the original is kept", () => {
  assert.deepEqual(newAlias("m", "a", true), { name: "m", alias: "a", fork: true });
  assert.deepEqual(newAlias("m", "a", false), { name: "m", alias: "a" });
});

test("aliasProblems follows the server: required, same as upstream, taken, all ignoring case", () => {
  const list = [newAlias("m", " Sonnet ", false)];
  assert.deepEqual(aliasProblems("", "", list), { name: "required", alias: "required" });
  assert.deepEqual(aliasProblems("x", "sonnet", list), { name: undefined, alias: "duplicate" });
  assert.deepEqual(aliasProblems("x", "SONNET", list), { name: undefined, alias: "duplicate" });
  assert.deepEqual(aliasProblems("Claude-X", "claude-x", list), { name: undefined, alias: "same" });
  assert.deepEqual(aliasProblems("a", "m", list), { name: undefined, alias: undefined });
  assert.deepEqual(aliasProblems("", "free", list), { name: "required", alias: undefined });
});

test("isExcluded matches a listed pattern exactly", () => {
  assert.equal(isExcluded(["claude-3-*"], "claude-3-*"), true);
  assert.equal(isExcluded(["claude-3-*"], "claude-3-"), false);
  assert.equal(isExcluded([], "a"), false);
});

test("modelRows reads either limit spelling, its aliases and the pattern that hides it", () => {
  const base = { object: "model", created: 0, owned_by: "x", type: "x" };
  const [opus, gemini] = modelRows(
    "claude",
    [
      { ...base, id: "Claude-3-Opus", context_length: 200_000, max_completion_tokens: 64_000 },
      { ...base, id: "g", display_name: "G", inputTokenLimit: 1_048_576 },
    ],
    [newAlias(" claude-3-opus ", "opus", false), newAlias("g", "gee", true)],
    ["*-preview", "CLAUDE-3-*"],
  );
  assert.deepEqual(opus, {
    key: "claude/Claude-3-Opus",
    channel: "claude",
    id: "Claude-3-Opus",
    name: "",
    context: 200_000,
    output: 64_000,
    aliases: ["opus"],
    excludedBy: "CLAUDE-3-*",
  });
  assert.equal(gemini.name, "G");
  assert.equal(gemini.excludedBy, undefined);
  assert.equal(kilo(gemini.context), "1M");
  assert.equal(kilo(gemini.output), null);
  assert.equal(kilo(512), "512");
});

test("wildcard matches as the server does", () => {
  for (const [p, v, ok] of [
    ["a*c", "abc", true],
    ["a*c", "ab", false],
    ["*", "x", true],
    ["a**b", "ab", true],
    ["x", "x", true],
    ["*mid*", "a-mid-b", true],
    ["a*b*c", "acb", false],
    ["", "", false],
  ] as const)
    assert.equal(wildcard(p, v), ok, `${p} ${v}`);
});

test("ruleRows keeps each entry's stored index", () => {
  const rows = ruleRows("codex", [newAlias("m", "a", true)], ["x", "y"]);
  assert.deepEqual(
    rows.map((r) => r.confirmed),
    [newAlias("m", "a", true), "x", "y"],
  );
  assert.deepEqual(
    rows.map((r) => [r.kind, r.index, r.pattern, r.alias, r.fork]),
    [
      ["alias", 0, "m", "a", true],
      ["excluded", 0, "x", undefined, undefined],
      ["excluded", 1, "y", undefined, undefined],
    ],
  );
});

test("matchesQuery looks at every text, ignoring case and outer spaces", () => {
  assert.equal(matchesQuery(["claude-opus", "Opus Four"], "  OPUS "), true);
  assert.equal(matchesQuery(["claude-opus", undefined], "four"), false);
  assert.equal(matchesQuery([], "  "), true);
});

test("pageOf clamps the page and slices 20 rows", () => {
  const rows = Array.from({ length: 45 }, (_, i) => i);
  assert.deepEqual(pageOf(rows, 3), { page: 3, rows: [40, 41, 42, 43, 44] });
  assert.equal(pageOf(rows, 9).page, 3);
  assert.equal(pageOf(rows, Number.NaN).page, 1);
  assert.deepEqual(pageOf([], 2), { page: 1, rows: [] });
});

test("token counts read the same in every language", async () => {
  const { setLocale } = await import("../../lib/i18n.ts");
  try {
    assert.equal(kilo(1500), "1.5K");
    assert.equal(kilo(1_048_576), "1M");
    setLocale("zh-CN");
    assert.equal(kilo(200_000), "200K");
  } finally {
    setLocale("en");
  }
});
