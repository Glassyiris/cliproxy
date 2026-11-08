import { strict as assert } from "node:assert";
import { test } from "node:test";

// lib/api/client.ts reads the page address when it loads.
Object.assign(globalThis, { location: { href: "http://cpa.test/management.html" } });
const { ApiError, ConnectionError } = await import("../lib/api/client.ts");
const { ConfigChangedError } = await import("../lib/api/config.ts");
const { onNotice } = await import("../lib/notify.ts");
const { t } = await import("../lib/i18n.ts");
const { createAction, failureNotice } = await import("./useAction.ts");

const route = { method: "PUT", path: "/config/{*path}" } as const;

function recorder() {
  const seen: string[] = [];
  const stop = onNotice((n) => seen.push(`${n.level}:${n.message}`));
  return { seen, stop };
}

test("one press is one effect: a second run while the first is pending does nothing", async () => {
  const busy: boolean[] = [];
  const run = createAction((b) => busy.push(b));
  const pending: (() => void)[] = [];
  let calls = 0;
  const work = () => {
    calls++;
    return new Promise<void>((resolve) => pending.push(resolve));
  };
  const first = run(work);
  const second = run(work);
  // Checked before anything settles, so a broken guard fails here instead of waiting forever.
  assert.equal(calls, 1);
  pending.forEach((release) => release());
  assert.equal(await second, false);
  assert.equal(await first, true);
  assert.deepEqual(busy, [true, false]);
  // Once it settled, the next press runs again.
  const again = run(work);
  pending.forEach((release) => release());
  assert.equal(await again, true);
  assert.equal(calls, 2);
});

test("success is a success notice; a failure is an error notice with the server's message", async () => {
  const { seen, stop } = recorder();
  const run = createAction(() => {});
  assert.equal(await run(() => Promise.resolve(), "Saved."), true);
  assert.equal(await run(() => Promise.resolve()), true);
  assert.equal(
    await run(
      () => Promise.reject(new ApiError("upstream said no", 502, "bad_gateway", route)),
      "Saved.",
    ),
    false,
  );
  stop();
  assert.deepEqual(seen, ["success:Saved.", "error:upstream said no"]);
});

test("each failure maps to its level and message", () => {
  assert.deepEqual(failureNotice(new ConfigChangedError("routing/strategy")), {
    level: "error",
    message: t("app.action.configChanged"),
  });
  assert.deepEqual(failureNotice(new ConnectionError("timeout")), {
    level: "error",
    message: t("app.connection.timeout"),
  });
  assert.deepEqual(failureNotice(new ConnectionError("unreachable")), {
    level: "error",
    message: t("app.connection.unreachable"),
  });
  assert.deepEqual(failureNotice(new Error("bad JSON")), { level: "error", message: "bad JSON" });
  // The session already told the user, or nobody is left to tell.
  assert.equal(failureNotice(new ApiError("unauthorized", 401, "", route)), null);
  assert.equal(failureNotice(new ConnectionError("session-changed")), null);
  assert.equal(failureNotice(new ConnectionError("signed-out")), null);
});
