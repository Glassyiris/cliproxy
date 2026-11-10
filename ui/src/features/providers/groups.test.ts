import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiKeyUsage } from "../../lib/api/observability.ts";
import {
  entriesOf,
  entryId,
  formErrors,
  groupNames,
  groupsOf,
  isFailing,
  isHttpUrl,
  keyTraffic,
  modelText,
  newGroup,
  storedGroups,
} from "./groups.ts";

const bucket = (success: number, failed: number) => ({ time: "", success, failed });

test("entryId follows the persisted provider when groups reorder and rejects missing IDs", () => {
  const first = { "@id": "provider-a", name: "a", keys: [] };
  const second = { "@id": "provider-b", name: "b", keys: [] };
  const before = entriesOf({ "api-keys": { claude: [first, second] } }, undefined, String)[0][1];
  const after = entriesOf({ "api-keys": { claude: [second, first] } }, undefined, String)[0][1];
  assert.equal(entryId(before[0]), "claude:provider-a");
  assert.equal(entryId(after[1]), entryId(before[0]));
  assert.notEqual(entryId(after[0]), entryId(before[0]));
  assert.throws(() => entryId({ family: "claude", group: {} }), /persisted identity/);
});

const usage: ApiKeyUsage = {
  claude: { "auth-a": { success: 1, failed: 0, recent_requests: [bucket(2, 1), bucket(0, 0)] } },
  openrouter: {
    "auth-b": { success: 5, failed: 0, recent_requests: [bucket(9, 0)] },
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

test("keyTraffic uses auth_index with masked keys, under the family or compatibility name", () => {
  const claude = keyTraffic(
    usage,
    "claude",
    { name: "team" },
    { "api-key": "$secret", auth_index: "auth-a" },
  );
  assert.deepEqual(claude, { total: [3, 0], failed: [1, 0], times: ["", ""] });
  const compat = { name: "OpenRouter", "base-url": "https://r.example/v1" };
  assert.deepEqual(
    keyTraffic(usage, "openai-compatibility", compat, {
      "api-key": "$secret",
      auth_index: "auth-b",
    }),
    {
      total: [9],
      failed: [0],
      times: [""],
    },
  );
  assert.equal(keyTraffic(usage, "claude", {}, { auth_index: "auth-x" }), null);
  assert.equal(keyTraffic(undefined, "claude", {}, { auth_index: "auth-a" }), null);
  assert.equal(keyTraffic(usage, "claude", {}, { "api-key": "$secret" }), null);
  assert.equal(keyTraffic(usage, "claude", {}, { "api-key": "auth-a" }), null);
});

test("entriesOf lists configured families in order and adds up each group's keys", () => {
  const config = {
    "api-keys": {
      codex: [],
      claude: [
        {
          "@id": "provider-team",
          name: "team",
          keys: [
            { "@id": "key-a", "api-key": "$secret", auth_index: "auth-a" },
            { "@id": "key-x", "api-key": "$secret", auth_index: "auth-x" },
          ],
        },
      ],
    },
  };
  const entries = entriesOf(config, usage, (n) => `Group ${n}`);
  assert.deepEqual(
    entries.map(([family, list]) => [family, list.map((e) => e.name)]),
    [["claude", ["team"]]],
  );
  assert.deepEqual(entries[0][1][0].traffic, { total: [3, 0], failed: [1, 0], times: ["", ""] });
  assert.equal(entries[0][1][0].group, config["api-keys"].claude[0]);
  assert.equal(entries[0][1][0].group["@id"], "provider-team");
  assert.equal(entries[0][1][0].keys[0].key, config["api-keys"].claude[0].keys[0]);
  assert.equal(entries[0][1][0].keys[0].key["@id"], "key-a");
  const group = config["api-keys"].claude[0];
  const reordered = { ...group, keys: [...group.keys].reverse(), disabled: true };
  const updated = entriesOf({ "api-keys": { claude: [reordered] } }, usage, String)[0][1][0];
  assert.equal(updated.group["@id"], "provider-team");
  assert.deepEqual(
    updated.keys.map(({ key }) => key["@id"]),
    ["key-x", "key-a"],
  );
  assert.equal(updated.keys[1].key.auth_index, "auth-a");
  assert.equal(updated.keys[1].key["api-key"], "$secret");
});

test("a key is failing when at least half of its requests failed", () => {
  assert.equal(isFailing(null), false);
  assert.equal(isFailing({ total: [4, 0], failed: [1, 0] }), false);
  assert.equal(isFailing({ total: [2, 2], failed: [1, 1] }), true);
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
  assert.deepEqual(formErrors({ ...fields, key: "$secret" }, false), { key: true });
  assert.deepEqual(formErrors({ name: "", baseUrl: "https://x/v1", key: "" }, true), {
    name: true,
    key: true,
  });
});
