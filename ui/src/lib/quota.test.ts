import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Credential } from "./api/credentials.ts";
import { fakeServer } from "./api/fake-server.test-support.ts";

const server = fakeServer();
const { connect } = await import("./api/client.ts");
const { createQuotaChecker } = await import("./quota.ts");
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
});
