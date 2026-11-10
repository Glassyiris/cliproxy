import assert from "node:assert/strict";
import { test } from "node:test";
import { dynamicKeys, hinted } from "../../i18n/config.ts";
import { absent } from "../../lib/configPath.ts";
import {
  changes,
  editDraft,
  diffText,
  groups,
  isValid,
  settingId,
  settings,
  shown,
} from "./settings.ts";

const setting = (path: string) => settings.find((s) => s.path === path)!;

test("shown takes the draft, then the stored value, then the server default", () => {
  const port = setting("server/port");
  assert.equal(shown({}, port, {}), 8317);
  assert.equal(shown({ server: { port: 9000 } }, port, {}), 9000);
  assert.equal(shown({ server: { port: 9000 } }, port, { "server/port": 9001 }), 9001);
});

test("changes skips a value drafted back to the saved one or to the default of an unset key", () => {
  const config = { server: { port: 9000 } };
  assert.deepEqual(changes(config, { "server/port": 9000, "routing/session-affinity": false }), []);
  const [change] = changes(config, { "server/port": 9001 });
  assert.equal(change?.before, 9000);
  assert.equal(change?.after, 9001);
});

test("diffText writes dotted keys and marks an unset key", () => {
  const list = changes({ server: { port: 9000 } }, { "server/port": 9001, "server/host": "::" });
  assert.equal(
    diffText(list, "(unset)"),
    '-server.host: (unset)\n+server.host: "::"\n-server.port: 9000\n+server.port: 9001',
  );
});

test("a duration must be one Go accepts", () => {
  const ttl = setting("routing/session-affinity-ttl");
  assert.equal(isValid(ttl, "1h30m"), true);
  assert.equal(isValid(ttl, "90"), false);
});

test("every group, setting and unit has its names in the catalog", () => {
  const listed = new Set(dynamicKeys);
  const wanted = [
    ...groups.flatMap((g) => [`config.group.${g}`]),
    ...settings.map((s) => `config.label.${settingId(s)}`),
    ...hinted.map((id) => `config.hint.${id}`),
    ...settings.flatMap((s) => (s.kind === "number" && s.units ? [`config.unit.${s.units}`] : [])),
  ];
  assert.deepEqual(
    wanted.filter((key) => !listed.has(key)),
    [],
  );
});

test("every hint belongs to a setting", () => {
  const ids = new Set<string>(settings.map(settingId));
  assert.deepEqual(
    hinted.filter((id) => !ids.has(id)),
    [],
  );
});

test("draft baseline survives a refetch and subsequent edits", () => {
  const path = "server/port";
  const first = editDraft({ server: { port: 0 } }, {}, path, 2);
  const next = editDraft({ server: { port: 4 } }, first.values, path, 3, first.baseline);
  assert.equal(changes({ server: { port: 4 } }, next.values, next.baseline)[0]?.before, 0);
});

test("each field keeps the value from its own first edit", () => {
  const first = editDraft({ server: { port: 9000, host: "a" } }, {}, "server/port", 9001);
  const latest = { server: { port: 9002, host: "b" } };
  const second = editDraft(latest, first.values, "server/host", "c", first.baseline);
  const pending = changes(latest, second.values, second.baseline);
  assert.equal(pending.find((c) => c.setting.path === "server/port")?.before, 9000);
  assert.equal(pending.find((c) => c.setting.path === "server/host")?.before, "b");
});

test("pending changes retain absent and stored baselines together after a refetch", () => {
  const original = { server: { port: 9000 } };
  const first = editDraft(original, {}, "server/host", "localhost");
  const second = editDraft(original, first.values, "server/port", 9001, first.baseline);
  const pending = changes(
    { server: { host: "other", port: 9002 } },
    second.values,
    second.baseline,
  );
  assert.equal(pending.length, 2);
  assert.equal(pending.find((change) => change.setting.path === "server/host")?.before, absent);
  assert.equal(pending.find((change) => change.setting.path === "server/port")?.before, 9000);
});
