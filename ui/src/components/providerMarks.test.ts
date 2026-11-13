import { strict as assert } from "node:assert";
import { test } from "node:test";
import { markOf, pathsOf } from "./providerMarks.ts";

test("provider marks: aliases share a mark, ids with none fall back", () => {
  assert.equal(markOf("claude"), "claude");
  assert.equal(markOf("anthropic"), "claude");
  assert.equal(markOf("kimi-ai"), "kimi");
  assert.equal(markOf("vertex"), "vertexai");
  // OpenAI-compatible endpoints and unknown providers have no mark; neither do inherited keys.
  for (const id of ["openai-compatibility", "interactions", "some-provider", "", "constructor"])
    assert.equal(markOf(id), undefined, id);
  assert.ok(pathsOf("vertexai").length > 1);
});
