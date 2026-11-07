import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plugin } from "../../lib/api/plugins.ts";
import { capabilities, pluginState, storedEnabled } from "./rows.ts";

const plugin = (over: Partial<Plugin>) =>
  ({
    registered: true,
    enabled: true,
    effective_enabled: true,
    supports_oauth: false,
    supports_quota: false,
    ...over,
  }) as Plugin;

test("a registered, effective plugin is loaded", () => {
  assert.equal(pluginState(plugin({})), "loaded");
});

test("an enabled plugin the server has not registered needs a restart", () => {
  assert.equal(pluginState(plugin({ registered: false, effective_enabled: false })), "restart");
});

test("an enabled plugin that is not effective needs a restart", () => {
  assert.equal(pluginState(plugin({ effective_enabled: false })), "restart");
});

test("a switched-off plugin is disabled, registered or not", () => {
  assert.equal(pluginState(plugin({ enabled: false, effective_enabled: false })), "disabled");
  assert.equal(
    pluginState(plugin({ registered: false, enabled: false, effective_enabled: false })),
    "disabled",
  );
});

test("capabilities list sign-in before quota", () => {
  assert.deepEqual(capabilities(plugin({ supports_oauth: true, supports_quota: true })), [
    "signIn",
    "quota",
  ]);
  assert.deepEqual(capabilities(plugin({})), []);
});

test("storedEnabled keeps null and false, and reads an absent key as {}", () => {
  const config = {
    plugins: { enabled: false, configs: { a: { enabled: null }, b: {}, c: null } },
  };
  assert.equal(storedEnabled(config), false);
  assert.equal(storedEnabled(config, "a"), null);
  assert.deepEqual(storedEnabled(config, "b"), {});
  assert.deepEqual(storedEnabled(config, "c"), {});
  assert.deepEqual(storedEnabled(config, "missing"), {});
  assert.deepEqual(storedEnabled({}), {});
  assert.deepEqual(storedEnabled({ plugins: null }, "a"), {});
});
