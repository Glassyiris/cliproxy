import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeServer } from "./fake-server.test-support.ts";

const server = fakeServer();
const { ApiError, ConnectionError, available, connect, disconnect, probe, request } = await import("./client.ts");
const { routes } = await import("./routes.ts");
const { accountProbes, usageProbes } = await import("./probes.ts");

const versions: (string | null)[] = [];
let rejected = 0;
const signIn = () => connect("secret", { unauthorized: () => rejected++, version: (v) => versions.push(v) });

test("the key stays in memory: no request before sign-in, a bearer header after, never storage", async () => {
  disconnect();
  await assert.rejects(request(routes.readConfig), (e) => e instanceof ConnectionError && e.reason === "signed-out");
  assert.equal(server.sent.length, 0);
  signIn();
  server.answer = () => Response.json({ "config-version": 8 }, { headers: { "X-CPA-VERSION": "cliproxy-rs-1.0.0" } });
  assert.deepEqual(await request(routes.readConfig), { "config-version": 8 });
  assert.equal(server.sent[0].headers.Authorization, "Bearer secret");
  assert.equal(server.sent[0].url.href, "http://cpa.test/v8/management/config");
  assert.equal(versions.at(-1), "cliproxy-rs-1.0.0");
  for (const file of ["client.ts", "routes.ts"])
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /localStorage|sessionStorage|indexedDB|document\.cookie/);
});

test("server errors keep status and message; 401 signs out", async () => {
  signIn();
  server.answer = () => Response.json({ error: "invalid management key" }, { status: 401 });
  await assert.rejects(request(routes.readConfig), (e) => e instanceof ApiError && e.status === 401 && e.message === "invalid management key" && !e.notImplemented);
  assert.equal(rejected, 1);
  server.answer = () => Response.json({ error: "invalid_plugin_id", message: "invalid plugin id" }, { status: 400 });
  await assert.rejects(request(routes.deletePlugin, { params: { id: "a b" } }), (e) => e instanceof ApiError && e.code === "invalid_plugin_id" && e.message === "invalid plugin id");
  assert.equal(server.sent.at(-1)!.url.pathname, "/v8/management/plugins/a%20b");
});

test("an empty 404, 501 or 405 marks the route not implemented until the next sign-in", async () => {
  signIn();
  server.answer = () => Response.json({ error: "not_found" }, { status: 404 });
  await assert.rejects(request(routes.readConfigValue, { params: { path: "x" } }), (e) => e instanceof ApiError && !e.notImplemented);
  assert.equal(available(routes.readConfigValue), true);
  for (const status of [404, 501, 405]) {
    server.answer = () => new Response(null, { status });
    await assert.rejects(request(routes.clearLogs), (e) => e instanceof ApiError && e.notImplemented);
  }
  assert.equal(available(routes.clearLogs), false);
  signIn();
  assert.equal(available(routes.clearLogs), true);
});

test("probes are side-effect-free requests, sent once per session", async () => {
  signIn();
  server.sent.length = 0;
  server.answer = () => new Response(null, { status: 404 });
  probe(usageProbes);
  probe(accountProbes);
  probe(usageProbes);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(server.sent.length, 1 + accountProbes.length);
  const queue = server.sent[0];
  assert.equal(`${queue.method} ${queue.url.pathname}${queue.url.search}`, "GET /v8/management/observability/usage/queue?count=0");
  assert.equal(queue.body, undefined);
  for (const s of server.sent.slice(1)) assert.deepEqual([s.body, s.headers["Content-Type"]], [{}, "application/json"]);
  assert.equal(available(routes.uploadCredentials), false);
});

test("an aborted read rejects as aborted, and an answer from an old session is dropped", async () => {
  signIn();
  const controller = new AbortController();
  controller.abort();
  const before = versions.length;
  await assert.rejects(request(routes.listCredentials, { signal: controller.signal }), (e) => (e as Error).name === "AbortError");
  assert.equal(versions.length, before);
  server.answer = () => {
    disconnect();
    return Response.json({ files: [] });
  };
  await assert.rejects(request(routes.listCredentials), (e) => e instanceof ConnectionError && e.reason === "session-changed");
});
