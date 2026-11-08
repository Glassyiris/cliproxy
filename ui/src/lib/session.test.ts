import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fakeServer } from "./api/fake-server.test-support.ts";

const server = fakeServer();
const { request, ConnectionError } = await import("./api/client.ts");
const { routes } = await import("./api/routes.ts");
const { openSession, SignInError } = await import("./session.ts");
const { setLocale, t } = await import("./i18n.ts");
const catalog = (await import("../i18n/app.ts")).default;

const hooks = { unauthorized() {}, server() {} };
const refusal = async (answer: () => Response | Promise<Response>) => {
  server.answer = answer;
  const error = await openSession("guess", hooks).catch((e: unknown) => e);
  assert.ok(error instanceof SignInError);
  return error.message;
};

test("each refused sign-in names what to change, and the key is dropped", async () => {
  setLocale("en");
  assert.equal(
    await refusal(() => Response.json({ error: "invalid management key" }, { status: 401 })),
    catalog.en["app.signIn.wrongKey"],
  );
  await assert.rejects(
    request(routes.readConfig),
    (e) => e instanceof ConnectionError && e.reason === "signed-out",
  );
  assert.equal(
    await refusal(() => new Response(null, { status: 404 })),
    catalog.en["app.signIn.apiOff"],
  );
  assert.equal(
    await refusal(() => Response.json({ error: "remote management disabled" }, { status: 403 })),
    catalog.en["app.signIn.remoteDisabled"],
  );
  assert.equal(
    await refusal(() =>
      Response.json({ error: "IP banned due to too many failed attempts" }, { status: 403 }),
    ),
    t("app.signIn.banned", { message: "IP banned due to too many failed attempts" }),
  );
  assert.equal(
    await refusal(() => Promise.reject(new TypeError("Failed to fetch"))),
    catalog.en["app.connection.unreachable"],
  );
});

test("each refusal names its reason: only a 401 rejects the key", async () => {
  const reason = async (answer: () => Response | Promise<Response>) => {
    server.answer = answer;
    const error = await openSession("guess", hooks).catch((e: unknown) => e);
    assert.ok(error instanceof SignInError);
    return error.reason;
  };
  assert.equal(
    await reason(() => Response.json({ error: "invalid management key" }, { status: 401 })),
    "rejected",
  );
  assert.equal(await reason(() => Promise.reject(new TypeError("Failed to fetch"))), "unreachable");
  assert.equal(await reason(() => new Response(null, { status: 404 })), "other");
  assert.equal(
    await reason(() => Response.json({ error: "remote management disabled" }, { status: 403 })),
    "other",
  );
  assert.equal(
    await reason(() =>
      Response.json({ error: "IP banned due to too many failed attempts" }, { status: 403 }),
    ),
    "other",
  );
  assert.equal(await reason(() => Response.json({ error: "boom" }, { status: 500 })), "other");
});

test("a check given up through its signal counts as unreachable", async () => {
  server.answer = () => Response.json({});
  const error = await openSession("guess", hooks, AbortSignal.abort()).catch((e: unknown) => e);
  assert.ok(error instanceof SignInError);
  assert.equal(error.reason, "unreachable");
  await assert.rejects(
    request(routes.readConfig),
    (e) => e instanceof ConnectionError && e.reason === "signed-out",
  );
});

test("the help follows the chosen language", async () => {
  setLocale("zh-TW");
  assert.equal(
    await refusal(() => new Response(null, { status: 404 })),
    catalog["zh-TW"]["app.signIn.apiOff"],
  );
  setLocale("en");
});

test("a good key opens the session and sends each capability probe once", async () => {
  server.sent.length = 0;
  server.answer = () => Response.json({ "config-version": 8 });
  await openSession("secret", hooks);
  await openSession("secret", hooks);
  const paths = server.sent.map((s) => `${s.method} ${s.url.pathname}`);
  assert.equal(paths.filter((p) => p === "GET /v8/management/config").length, 2);
  const probes = paths.filter((p) => p !== "GET /v8/management/config");
  assert.ok(probes.length > 0);
  assert.equal(
    new Set(probes).size,
    probes.length / 2,
    "a new session probes again, once per route",
  );
});
