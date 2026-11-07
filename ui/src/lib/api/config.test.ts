import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fakeServer } from "./fake-server.test-support.ts";

const server = fakeServer();
const { connect } = await import("./client.ts");
const { ConfigChangedError, readConfigValue, replaceConfigValue, writeConfigYaml } = await import("./config.ts");
connect("secret", { unauthorized() {}, version() {} });

const ok = { "config-version": 8, status: "ok" };

test("replace rereads, compares, and writes only when the server still holds the shown value", async () => {
  let held: unknown = ["a"];
  server.answer = (s) => (s.method === "PUT" ? ((held = s.body), Response.json(ok)) : Response.json(held));
  server.sent.length = 0;
  await replaceConfigValue("access/api-keys", ["a"], ["a", "b"]);
  assert.deepEqual(server.sent.map((s) => `${s.method} ${s.url.pathname}`), ["GET /v8/management/config/access/api-keys", "PUT /v8/management/config/access/api-keys"]);
  assert.deepEqual(held, ["a", "b"]);

  server.sent.length = 0;
  await assert.rejects(replaceConfigValue("access/api-keys", ["a"], []), ConfigChangedError);
  assert.deepEqual(server.sent.map((s) => s.method), ["GET"]);
});

test("an unset key reads as the fallback; any other error stays an error", async () => {
  server.answer = (s) => (s.method === "PUT" ? Response.json(ok) : Response.json({ error: "not_found" }, { status: 404 }));
  assert.deepEqual(await readConfigValue("oauth/model-alias/codex", { fallback: [] }), []);
  await assert.rejects(readConfigValue("oauth/model-alias/codex"));
  await replaceConfigValue("oauth/model-alias/codex", [], [{ name: "m" }]);
  server.answer = () => Response.json({ error: "read_failed" }, { status: 500 });
  await assert.rejects(readConfigValue("routing", { fallback: {} }));
  await assert.rejects(readConfigValue("oauth/../key"), /Invalid configuration path/);
});

test("config.yaml goes as YAML text, other writes as JSON", async () => {
  server.answer = () => Response.json(ok);
  await writeConfigYaml("debug: true\n");
  const s = server.sent.at(-1)!;
  assert.deepEqual([s.headers["Content-Type"], s.body], ["application/yaml", "debug: true\n"]);
});
