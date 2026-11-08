import assert from "node:assert/strict";
import { test } from "node:test";
import { tools } from "../../lib/toolSetup.ts";
import { toolFromParam, toolParam } from "./tool.ts";

test("every tool survives the round trip through the hash", () => {
  for (const tool of tools) assert.equal(toolFromParam(toolParam(tool)), tool);
});

test("the first tool leaves no value and an unknown value reads as the first tool", () => {
  assert.equal(toolParam(tools[0]), undefined);
  assert.equal(toolParam("Cursor"), "cursor");
  assert.equal(toolFromParam("sk-secret"), tools[0]);
  assert.equal(toolFromParam(undefined), tools[0]);
});
