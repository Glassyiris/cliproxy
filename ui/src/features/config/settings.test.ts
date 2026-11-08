import assert from "node:assert/strict";
import { test } from "node:test";
import { dynamicKeys, hinted } from "../../i18n/config.ts";
import { changes, diffText, groups, isValid, settingId, settings, shown } from "./settings.ts";

const setting = (path: string) => settings.find((s) => s.path === path)!;

test("shown takes the draft, then the file, then the server default", () => {
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
