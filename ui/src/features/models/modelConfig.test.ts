import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogRow,
  aliasProblems,
  kilo,
  matchesQuery,
  newAlias,
  readList,
  isExcluded,
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

test("catalogRow reads either limit spelling, and kilo words the limits", () => {
  const base = { id: "m", object: "model", created: 0, owned_by: "x", type: "x" };
  assert.deepEqual(
    catalogRow({ ...base, context_length: 200_000, max_completion_tokens: 64_000 }),
    {
      id: "m",
      name: "",
      context: 200_000,
      output: 64_000,
    },
  );
  const gemini = catalogRow({ ...base, display_name: "G", inputTokenLimit: 1_048_576 });
  assert.equal(gemini.name, "G");
  assert.equal(kilo(gemini.context), "1049k");
  assert.equal(kilo(gemini.output), null);
  assert.equal(kilo(512), "512");
});

test("matchesQuery looks at the id and the display name, ignoring case and outer spaces", () => {
  const row = catalogRow({
    id: "claude-opus",
    object: "model",
    created: 0,
    owned_by: "x",
    type: "x",
    display_name: "Opus Four",
  });
  assert.equal(matchesQuery(row, "  OPUS "), true);
  assert.equal(matchesQuery(row, "four"), true);
  assert.equal(matchesQuery(row, "sonnet"), false);
  assert.equal(matchesQuery(row, "  "), true);
});
