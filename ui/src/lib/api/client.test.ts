import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { fakeServer } from "./fakeServer.testSupport.ts";
import type { ServerBuild } from "./client.ts";

const storageAccess = mock.fn(() => undefined);
for (const name of ["localStorage", "sessionStorage", "indexedDB"])
  Object.defineProperty(globalThis, name, { configurable: true, get: storageAccess });
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: Object.defineProperty({}, "cookie", { get: storageAccess, set: storageAccess }),
});

const server = fakeServer("http://cpa.test/proxy/management.html");
// Dynamic imports let fakeServer install location before the client initializes its base URL.
const { ApiError, ConnectionError, available, connect, disconnect, probe, request } =
  await import("./client.ts");
const { routes } = await import("./routes.ts");
const { accountProbes, usageProbes } = await import("./probes.ts");

const builds: (ServerBuild | null)[] = [];
let rejected = 0;
const signIn = () => connect({ unauthorized: () => rejected++, server: (b) => builds.push(b) });

test("API requests carry the session cookie, never a key, and never access storage", async () => {
  disconnect();
  await assert.rejects(
    request(routes.readConfig),
    (e) => e instanceof ConnectionError && e.reason === "signed-out",
  );
  assert.equal(server.sent.length, 0);
  signIn();
  server.answer = () =>
    Response.json(
      { "config-version": 8 },
      {
        headers: { "X-Ck-Version": "cooker-1.0.0", "X-Ck-Commit": "abc1234" },
      },
    );
  assert.deepEqual(await request(routes.readConfig), { "config-version": 8 });
  assert.equal(server.sent[0].headers.Authorization, undefined);
  assert.equal(server.sent[0].headers["X-Ck-Dashboard"], "1");
  assert.equal(server.sent[0].credentials, "same-origin");
  assert.equal(server.sent[0].url.href, "http://cpa.test/proxy/admin/v1/effective/config");
  assert.deepEqual(builds.at(-1), { version: "cooker-1.0.0", commit: "abc1234", built: "" });
  disconnect();
  const sent = server.sent.length;
  await assert.rejects(
    request(routes.readConfig),
    (e) => e instanceof ConnectionError && e.reason === "signed-out",
  );
  assert.equal(server.sent.length, sent);
  assert.equal(storageAccess.mock.callCount(), 0);
});

test("only the sign-in request carries the key, and session requests work signed out", async () => {
  disconnect();
  server.sent.length = 0;
  server.answer = () => Response.json({ error: "invalid management key" }, { status: 401 });
  const before = rejected;
  await assert.rejects(
    request(routes.signIn, { body: { remember: true }, outside: { key: "typed" } }),
    (e) => e instanceof ApiError && e.status === 401,
  );
  await assert.rejects(
    request(routes.checkSession, { outside: {} }),
    (e) => e instanceof ApiError && e.status === 401,
  );
  assert.equal(rejected, before, "a refused sign-in is not an ended session");
  const [typed, check] = server.sent;
  assert.equal(typed.url.href, "http://cpa.test/proxy/v8/management/session");
  assert.equal(typed.headers.Authorization, "Bearer typed");
  assert.equal(typed.credentials, "same-origin");
  assert.equal(check.headers.Authorization, undefined);
  assert.equal(check.headers["X-Ck-Dashboard"], "1");
});

test("server errors keep status and message; 401 signs out", async () => {
  signIn();
  server.answer = () => Response.json({ error: "invalid management key" }, { status: 401 });
  await assert.rejects(
    request(routes.readConfig),
    (e) =>
      e instanceof ApiError &&
      e.status === 401 &&
      e.message === "invalid management key" &&
      !e.notImplemented,
  );
  assert.equal(rejected, 1);
  server.answer = () =>
    Response.json({ error: "invalid_log_name", message: "invalid log name" }, { status: 400 });
  await assert.rejects(
    request(routes.downloadErrorLog, { params: { name: "a b" } }),
    (e) =>
      e instanceof ApiError && e.code === "invalid_log_name" && e.message === "invalid log name",
  );
  assert.equal(
    server.sent.at(-1)!.url.pathname,
    "/proxy/v8/management/observability/logs/errors/a%20b",
  );
});

test("an empty 404, 501 or 405 marks the route not implemented until the next sign-in", async () => {
  signIn();
  server.answer = () => Response.json({ error: "not_found" }, { status: 404 });
  await assert.rejects(
    request(routes.readConfig),
    (e) => e instanceof ApiError && !e.notImplemented,
  );
  assert.equal(available(routes.readConfig), true);
  for (const status of [404, 501, 405]) {
    server.answer = () => new Response(null, { status });
    await assert.rejects(
      request(routes.clearLogs),
      (e) => e instanceof ApiError && e.notImplemented,
    );
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
  assert.equal(
    `${queue.method} ${queue.url.pathname}${queue.url.search}`,
    "GET /proxy/v8/management/observability/usage/queue?count=0",
  );
  assert.equal(queue.body, undefined);
  for (const s of server.sent.slice(1))
    assert.deepEqual([s.body, s.headers["Content-Type"]], [{}, "application/json"]);
  assert.equal(available(routes.uploadCredentials), false);
});

test("an aborted read rejects as aborted, and an answer from an old session is dropped", async () => {
  signIn();
  const controller = new AbortController();
  controller.abort();
  const before = builds.length;
  await assert.rejects(
    request(routes.listCredentials, { signal: controller.signal }),
    (e) => (e as Error).name === "AbortError",
  );
  assert.equal(builds.length, before);
  server.answer = () => {
    disconnect();
    return Response.json({ files: [] });
  };
  await assert.rejects(
    request(routes.listCredentials),
    (e) => e instanceof ConnectionError && e.reason === "session-changed",
  );
});

test("a bare answer reports empty build fields; Session keeps the earlier values", async () => {
  signIn();
  server.answer = () => new Response(null, { status: 404 });
  await assert.rejects(request(routes.clearLogs), (e) => e instanceof ApiError);
  assert.deepEqual(builds.at(-1), { version: "", commit: "", built: "" });
});

test("a 2xx body that cannot be read fails like an unreachable server", async () => {
  signIn();
  server.answer = () =>
    new Response("{not json", { headers: { "Content-Type": "application/json" } });
  await assert.rejects(
    request(routes.listCredentials),
    (e) => e instanceof ConnectionError && e.reason === "unreachable",
  );
  assert.equal(builds.at(-1), null);
  server.answer = () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    return new Response(body);
  };
  await assert.rejects(
    request(routes.readRequestLog, { params: { id: "request-one" }, as: "text" }),
    (e) => e instanceof ConnectionError && e.reason === "unreachable",
  );
});

test("a null error body keeps the HTTP status in ApiError", async () => {
  for (const status of [400, 404, 500]) {
    signIn();
    server.answer = () => Response.json(null, { status });
    await assert.rejects(
      request(routes.readConfig),
      (e) =>
        e instanceof ApiError &&
        e.status === status &&
        e.message === `HTTP ${status}` &&
        e.code === "" &&
        e.path === routes.readConfig.path,
    );
  }
});
