import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ConfigApplyResult, ConfigChange, ConfigOperation } from "./config.ts";
import { fakeServer } from "./fakeServer.testSupport.ts";

const server = fakeServer();
// Dynamic imports let fakeServer install location before the client initializes its base URL.
const { ApiError, connect } = await import("./client.ts");
const { absent, storedValue } = await import("../configPath.ts");
const { ConfigChangedError, readConfig, readConfigValue, replaceConfigValue, replaceConfigValues } =
  await import("./config.ts");
connect({ unauthorized() {}, server() {} });

const ok: ConfigApplyResult = {
  revision: 12,
  written: true,
  changes: [],
  restart_required: false,
};

test("effective reads keep stable resource identities and select values locally", async () => {
  const provider = {
    "@id": "provider-one",
    keys: [{ "@id": "key-one", "api-key": "$secret", auth_index: "live-index" }],
  };
  const config = { "api-keys": { claude: [provider] }, routing: { strategy: "fill-first" } };
  server.answer = () => Response.json(config);
  server.sent.length = 0;
  assert.deepEqual(await readConfig(), config);
  assert.deepEqual(await readConfigValue("api-keys/claude"), [provider]);
  assert.deepEqual(
    server.sent.map((s) => `${s.method} ${s.url.pathname}`),
    ["GET /admin/v1/effective/config", "GET /admin/v1/effective/config"],
  );
});

test("only a missing value uses a fallback; null and request errors stay intact", async () => {
  server.answer = () => Response.json({ access: { "api-keys": null } });
  assert.equal(await readConfigValue("access/api-keys", { fallback: [] }), null);
  assert.deepEqual(await readConfigValue("oauth/model-alias/codex", { fallback: [] }), []);
  assert.equal(await readConfigValue("missing", { fallback: absent }), absent);
  await assert.rejects(
    readConfigValue("missing"),
    (e) => e instanceof ApiError && e.status === 404 && e.code === "not_found",
  );
  server.answer = () => Response.json({ error: "read_failed" }, { status: 500 });
  await assert.rejects(
    readConfigValue("routing", { fallback: {} }),
    (e) => e instanceof ApiError && e.status === 500,
  );
});

test("multiple changes use one atomic apply with expectations and preserved @id fields", async () => {
  const before = [
    {
      "@id": "provider-one",
      keys: [{ "@id": "key-one", "api-key": "$secret", auth_index: "live-index" }],
    },
  ];
  const next = [{ ...before[0], prefix: "team" }];
  const changes: ConfigChange[] = [
    { path: "api-keys/claude", before, next },
    { path: "routing/strategy", before: "fill-first", next: "round-robin" },
  ];
  server.answer = () => Response.json(ok);
  server.sent.length = 0;
  assert.deepEqual(await replaceConfigValues(changes), ok);
  assert.equal(server.sent.length, 1);
  const sent = server.sent[0];
  assert.equal(`${sent.method} ${sent.url.pathname}`, "POST /admin/v1/apply");
  const ops: ConfigOperation[] = [
    { op: "set", path: "api-keys/claude", value: next, expect: before },
    { op: "set", path: "routing/strategy", value: "round-robin", expect: "fill-first" },
  ];
  assert.deepEqual(sent.body, { ops });
  assert.equal(sent.headers["Content-Type"], "application/json");
  assert.equal(sent.headers["If-Match"], undefined);
});

test("the single-value helper delegates to apply without a read or ETag", async () => {
  server.answer = () => Response.json(ok);
  server.sent.length = 0;
  await replaceConfigValue("routing/strategy", "fill-first", "round-robin");
  assert.equal(server.sent.length, 1);
  assert.deepEqual(server.sent[0].body, {
    ops: [{ op: "set", path: "routing/strategy", value: "round-robin", expect: "fill-first" }],
  });
});

test("absent baselines become JSON defaults and absent next values become unset ops", async () => {
  const path = "access/api-keys";
  assert.equal(storedValue({ access: { "api-keys": null } }, path), null);
  assert.equal(storedValue({ access: {} }, path), absent);
  assert.equal(storedValue({ access: null }, path), absent);
  server.answer = () => Response.json(ok);
  await replaceConfigValues([
    { path, before: absent, next: ["key"], unset: absent },
    { path: "oauth/model-alias", before: absent, next: {}, unset: {} },
    { path: "routing/strategy", before: absent, next: "round-robin" },
    { path: "routing/aliases/my alias", before: { enabled: true }, next: absent },
    { path: "upstream/proxy-url", before: null, next: "http://proxy.test" },
    { path: "server/host", before: undefined, next: "127.0.0.1" },
  ]);
  assert.deepEqual(server.sent.at(-1)!.body, {
    ops: [
      { op: "set", path, value: ["key"], expect: null },
      { op: "set", path: "oauth/model-alias", value: {}, expect: {} },
      { op: "set", path: "routing/strategy", value: "round-robin", expect: null },
      { op: "unset", path: "routing/aliases/my alias", expect: { enabled: true } },
      { op: "set", path: "upstream/proxy-url", value: "http://proxy.test", expect: null },
      { op: "set", path: "server/host", value: "127.0.0.1", expect: null },
    ],
  });
});

test("a 412 rejects the whole batch as ConfigChangedError without a retry", async () => {
  server.answer = () =>
    Response.json({ error: "precondition_failed", message: "changed" }, { status: 412 });
  server.sent.length = 0;
  await assert.rejects(
    replaceConfigValues([
      { path: "routing/strategy", before: "fill-first", next: "round-robin" },
      { path: "requests/retry/count", before: 0, next: 2 },
    ]),
    (e) => e instanceof ConfigChangedError && e.path.includes("routing/strategy"),
  );
  assert.equal(server.sent.length, 1);
  await assert.rejects(replaceConfigValue("requests/retry/count", 0, 2), ConfigChangedError);
  server.answer = () => Response.json({ error: "invalid_config" }, { status: 422 });
  await assert.rejects(
    replaceConfigValue("requests/retry/count", 0, 2),
    (e) => e instanceof ApiError && e.status === 422,
  );
});

test("invalid paths reject reads and entire batches before issuing a request", async () => {
  server.sent.length = 0;
  await assert.rejects(readConfigValue("oauth/../key"), /Invalid configuration path/);
  await assert.rejects(
    replaceConfigValues([
      { path: "routing/strategy", before: "fill-first", next: "round-robin" },
      { path: "oauth//key", before: absent, next: [] },
    ]),
    /Invalid configuration path/,
  );
  assert.equal(server.sent.length, 0);
});
