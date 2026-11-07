import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiKeyUsage } from "../../lib/api/observability.ts";
import {
  busiest,
  formErrors,
  groupNames,
  groupsOf,
  isHttpUrl,
  keyTraffic,
  modelText,
  newGroup,
  storedGroups,
} from "./groups.ts";

const bucket = (success: number, failed: number) => ({ time: "", success, failed });
const usage: ApiKeyUsage = {
  claude: { "|sk-a": { success: 1, failed: 0, recent_requests: [bucket(2, 1), bucket(0, 0)] } },
  openrouter: {
    "https://r.example/v1|sk-b": { success: 5, failed: 0, recent_requests: [bucket(9, 0)] },
  },
};

test("storedGroups keeps null and reads a missing family as the empty list", () => {
  assert.equal(storedGroups({ "api-keys": { claude: null } }, "claude"), null);
  assert.deepEqual(storedGroups({ "api-keys": {} }, "claude"), []);
  assert.deepEqual(storedGroups({}, "codex"), []);
  assert.deepEqual(storedGroups({ "api-keys": null }, "codex"), []);
  assert.deepEqual(groupsOf(null), []);
});

test("groupNames numbers unnamed groups and tells duplicates apart", () => {
  const unnamed = (n: number) => `Group ${n}`;
  assert.deepEqual(groupNames([{}, { name: " " }, { name: "a" }, { name: "a" }], unnamed), [
    "Group 1",
    "Group 2",
    "a",
    "a #4",
  ]);
});

test("groupNames keeps every name distinct when a suffixed name already exists", () => {
  const names = groupNames([{ name: "a" }, { name: "a" }, { name: "a #2" }], (n) => `Group ${n}`);
  assert.deepEqual(names, ["a", "a #2", "a #2 #3"]);
  assert.equal(new Set(names).size, 3);
  const mixed = groupNames([{ name: "a #2" }, { name: "a" }, { name: "a" }], (n) => `Group ${n}`);
  assert.equal(new Set(mixed).size, 3);
});

test("modelText shows an alias only when it differs", () => {
  assert.equal(modelText({ name: "m", alias: "x" }), "m → x");
  assert.equal(modelText({ name: "m", alias: "m" }), "m");
  assert.equal(modelText({ name: "m" }), "m");
});

test("keyTraffic finds usage by family, or by lower-cased name for OpenAI-compatible groups", () => {
  const claude = keyTraffic(usage, "claude", { name: "team" }, { "api-key": "sk-a" });
  assert.deepEqual(claude, { total: [3, 0], failed: [1, 0] });
  const compat = { name: "OpenRouter", "base-url": "https://r.example/v1" };
  assert.deepEqual(keyTraffic(usage, "openai-compatibility", compat, { "api-key": "sk-b" }), {
    total: [9],
    failed: [0],
  });
  assert.equal(keyTraffic(usage, "claude", { name: "team" }, { "api-key": "sk-x" }), null);
  assert.equal(keyTraffic(undefined, "claude", {}, { "api-key": "sk-a" }), null);
});

test("busiest is at least 1 and covers every key of the family", () => {
  assert.equal(busiest(undefined, "claude", []), 1);
  assert.equal(busiest(usage, "claude", [{ keys: [{ "api-key": "sk-a" }] }]), 3);
});

test("newGroup leaves the base URL out when empty", () => {
  assert.deepEqual(newGroup("n", "", "k"), { name: "n", keys: [{ "api-key": "k" }] });
  assert.deepEqual(newGroup("n", "https://x/v1", "k"), {
    name: "n",
    "base-url": "https://x/v1",
    keys: [{ "api-key": "k" }],
  });
});

test("isHttpUrl accepts http and https addresses only", () => {
  assert.equal(isHttpUrl("https://api.example.com/v1"), true);
  assert.equal(isHttpUrl("http://localhost:8080"), true);
  assert.equal(isHttpUrl("ftp://example.com"), false);
  assert.equal(isHttpUrl("example.com"), false);
  assert.equal(isHttpUrl("https://"), false);
});

test("formErrors asks for a base URL only from OpenAI-compatible groups, and checks it when given", () => {
  const fields = { name: "n", baseUrl: "", key: "k" };
  assert.deepEqual(formErrors(fields, false), {});
  assert.deepEqual(formErrors(fields, true), { baseUrl: "required" });
  assert.deepEqual(formErrors({ ...fields, baseUrl: "nope" }, false), { baseUrl: "invalid" });
  assert.deepEqual(formErrors({ name: "", baseUrl: "https://x/v1", key: "" }, true), {
    name: true,
    key: true,
  });
});
