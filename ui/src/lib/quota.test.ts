import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Credential } from "./api/credentials.ts";
import type { Plugin } from "./api/plugins.ts";
import { fakeServer } from "./api/fakeServer.testSupport.ts";

const server = fakeServer();
const { connect } = await import("./api/client.ts");
const { createQuotaChecker, quotaApplies } = await import("./quota.ts");
connect("secret", { unauthorized() {}, server() {} });

const account = (auth_index: string, extra: Partial<Credential> = {}) =>
  ({
    name: `${auth_index}.json`,
    auth_index,
    provider: "claude",
    disabled: false,
    quota: { signals: {} },
    ...extra,
  }) as Credential;

test("quota checks: button-driven, one at a time, each account at most once per 2 minutes", async () => {
  const list = [account("a"), account("b"), account("c", { disabled: true })];
  const checker = createQuotaChecker({ plugins: () => [], credentials: () => list });
  let open = 0,
    peak = 0;
  server.answer = () => {
    peak = Math.max(peak, ++open);
    return new Promise<Response>((r) =>
      setTimeout(() => {
        open--;
        r(
          Response.json({
            status_code: 200,
            header: {},
            body: JSON.stringify({ five_hour: { utilization: 40, resets_at: "" } }),
          }),
        );
      }, 5),
    );
  };
  assert.equal(server.sent.length, 0, "nothing is read until a check is asked for");

  checker.check(list[0]);
  checker.check(list[0]);
  assert.equal(checker.pending(list[0]), "queued");
  assert.equal(checker.wait(list[0]), 120_000);
  await checker.checkAll(list);

  const calls = server.sent.map((s) => (s.body as { authIndex: string }).authIndex);
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(peak, 1);
  assert.deepEqual(server.sent[0].body, {
    authIndex: "a",
    method: "GET",
    url: "https://api.anthropic.com/api/oauth/usage",
    header: {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-cli/2.1.280 (external, cli)",
    },
  });
  const reading = checker.limits(list[0]);
  assert.ok(reading && "windows" in reading && reading.windows[0].used === 40);
  assert.ok(checker.wait(list[0]) > 119_000);
  await checker.checkAll(list);
  assert.equal(server.sent.length, 2, "a second round inside 2 minutes sends nothing");
  assert.ok(checker.wait(list[0], Date.now() + 120_000) === 0);
});

test("a refused token keeps its status code next to the last known limits", async () => {
  const list = [
    account("d", {
      quota: {
        observed_at: "2026-10-02T12:00:00Z",
        signals: { "anthropic-ratelimit-unified-5h-utilization": "0.5" },
      },
    }),
  ];
  const checker = createQuotaChecker({ plugins: () => [], credentials: () => list });
  server.answer = () => Response.json({ status_code: 401, header: {}, body: "" });
  await checker.checkAll(list);
  const reading = checker.limits(list[0]);
  assert.ok(reading && "windows" in reading && reading.windows[0].used === 50);
  assert.equal(checker.reading(list[0])?.code, 401);
  assert.deepEqual(checker.reading(list[0])?.error, { reason: "tokenRefused", status: 401 });
});

test("a failed read is a code with its status, never a sentence", async () => {
  const list = [account("g"), account("h", { provider: "codex" })];
  const checker = createQuotaChecker({ plugins: () => [], credentials: () => list });
  server.answer = (s) =>
    Response.json({
      status_code: s.body && JSON.stringify(s.body).includes("chatgpt") ? 500 : 403,
      header: {},
      body: "",
    });
  await checker.checkAll(list);
  assert.deepEqual(checker.reading(list[0])?.error, { reason: "usageDenied", status: 403 });
  assert.deepEqual(checker.reading(list[1])?.error, { reason: "status", status: 500 });
});

test("an answer that is not usage data is malformed; an ended session records nothing", async () => {
  const list = [account("m"), account("n")];
  const checker = createQuotaChecker({ plugins: () => [], credentials: () => list });
  server.answer = () => Response.json({ status_code: 200, header: {}, body: "<html>" });
  await checker.checkAll([list[0]]);
  assert.deepEqual(checker.reading(list[0])?.error, { reason: "malformed" });

  // A new session starts while the request is out: its answer belongs to the old one.
  server.answer = () => {
    connect("secret", { unauthorized() {}, server() {} });
    return Response.json({ status_code: 401, header: {}, body: "" });
  };
  await checker.checkAll([list[1]]);
  assert.equal(checker.reading(list[1]), undefined);
});

test("whether a quota check applies does not depend on the server's routes", () => {
  const plugin = { id: "q", supports_quota: true, quota_provider: "gemini" } as Plugin;
  assert.equal(quotaApplies(account("i"), []), true);
  assert.equal(quotaApplies(account("j", { provider: "gemini" }), []), false);
  assert.equal(quotaApplies(account("k", { provider: "gemini" }), [plugin]), true);
});

test("a stopped checker drops its queue: no source read and no request after stop", async () => {
  const list = [account("e"), account("f")];
  let reads = 0;
  const checker = createQuotaChecker({
    plugins: () => [],
    credentials: () => (reads++, list),
  });
  const ok = () => Response.json({ status_code: 200, header: {}, body: "{}" });
  let answer!: () => void;
  const before = server.sent.length;
  // The first request waits for the test; any later one is answered at once.
  server.answer = () =>
    server.sent.length > before + 1
      ? ok()
      : new Promise<Response>((r) => {
          answer = () => r(ok());
        });
  checker.check(list[0]);
  const done = checker.check(list[1]);
  while (server.sent.length === before) await new Promise((r) => setTimeout(r, 1));
  checker.stop();
  const readsAtStop = reads;
  answer();
  await done;
  assert.equal(server.sent.length, before + 1, "the queued check sends nothing");
  assert.equal(reads, readsAtStop, "the queued check reads no source");
  assert.equal(checker.pending(list[1]), undefined);
});
