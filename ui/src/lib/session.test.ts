import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fakeServer, type Sent } from "./api/fakeServer.testSupport.ts";

const server = fakeServer("http://cpa.test/router/management.html");
// Dynamic imports let fakeServer install location before the client initializes its base URL.
const { request, ConnectionError } = await import("./api/client.ts");
const { routes } = await import("./api/routes.ts");
const { cancelSignIns, closeSession, openSession, resumeSession, revokeSession, SignInError } =
  await import("./session.ts");
const { loadLocale, setLocale, t } = await import("./i18n.ts");
const catalog = (await import("../i18n/app.ts")).default;
const zhTW = (await import("../i18n/zh-TW/app.ts")).default;

const hooks = { unauthorized() {}, server() {} };
const SESSION = "/router/v8/management/session";
const line = (s: Sent) => `${s.method} ${s.url.pathname}`;
/** The server's answers: the session routes by method, everything else 200. */
const answers =
  (session: Partial<Record<string, () => Response | Promise<Response>>>) => (s: Sent) =>
    s.url.pathname === SESSION
      ? (session[s.method] ?? (() => new Response(null, { status: 204 })))()
      : Response.json({});
const signedOutNow = () =>
  assert.rejects(
    request(routes.readConfig),
    (e) => e instanceof ConnectionError && e.reason === "signed-out",
  );

const refusal = async (answer: () => Response | Promise<Response>) => {
  server.answer = answers({ POST: answer });
  const error = await openSession("guess", false, hooks).catch((e: unknown) => e);
  assert.ok(error instanceof SignInError);
  return error.message;
};

test("each refused sign-in names what to change, and leaves the tab signed out", async () => {
  setLocale("en");
  assert.equal(
    await refusal(() => Response.json({ error: "invalid management key" }, { status: 401 })),
    catalog.en["app.signIn.wrongKey"],
  );
  await signedOutNow();
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

test("a key accepted without a kept cookie says so", async () => {
  server.answer = answers({
    GET: () => Response.json({ error: "invalid or expired session" }, { status: 401 }),
  });
  const error = await openSession("secret", false, hooks).catch((e: unknown) => e);
  assert.ok(error instanceof SignInError);
  assert.equal(error.message, catalog.en["app.signIn.cookieBlocked"]);
  await signedOutNow();
});

test("a check given up through its signal counts as unreachable", async () => {
  server.answer = answers({});
  const error = await openSession("guess", false, hooks, AbortSignal.abort()).catch(
    (e: unknown) => e,
  );
  assert.ok(error instanceof SignInError);
  assert.equal(error.message, catalog.en["app.connection.unreachable"]);
  await signedOutNow();
});

test("the help follows the chosen language", async () => {
  await loadLocale("zh-TW");
  setLocale("zh-TW");
  assert.equal(
    await refusal(() => new Response(null, { status: 404 })),
    zhTW["zh-TW"]["app.signIn.apiOff"],
  );
  setLocale("en");
});

test("the key goes once, to the session route; every later request rides the cookie", async () => {
  server.sent.length = 0;
  server.answer = answers({});
  await openSession("secret", true, hooks);
  const [signIn, check, ...probes] = server.sent;
  assert.equal(line(signIn), `POST ${SESSION}`);
  assert.equal(signIn.headers.Authorization, "Bearer secret");
  assert.deepEqual(signIn.body, { remember: true, path: "/router/" });
  assert.equal(line(check), `GET ${SESSION}`);
  assert.ok(probes.length > 0);
  for (const sent of [check, ...probes]) {
    assert.equal(sent.headers.Authorization, undefined, line(sent));
    assert.equal(sent.credentials, "same-origin", line(sent));
  }
  await request(routes.readConfig);
  assert.equal(server.sent.at(-1)?.headers.Authorization, undefined);
});

test("a load resumes the cookie's session without a key, or fails without one", async () => {
  closeSession();
  server.sent.length = 0;
  server.answer = answers({
    GET: () => Response.json({ error: "invalid or expired session" }, { status: 401 }),
  });
  await assert.rejects(resumeSession(hooks), SignInError);
  assert.deepEqual(server.sent.map(line), [`GET ${SESSION}`], "no key, no counted attempt");
  await signedOutNow();

  server.answer = answers({});
  await resumeSession(hooks);
  assert.equal(
    server.sent.filter((s) => s.method === "POST" && s.url.pathname === SESSION).length,
    0,
  );
  await request(routes.readConfig);
});

test("a sign-out elsewhere during the check cancels the sign-in and ends its session", async () => {
  closeSession();
  server.sent.length = 0;
  let resolveCheck!: (response: Response) => void;
  server.answer = answers({
    GET: () => new Promise<Response>((resolve) => (resolveCheck = resolve)),
  });
  const pending = openSession("secret", false, hooks);
  await new Promise((resolve) => setTimeout(resolve, 0));
  cancelSignIns();
  resolveCheck(new Response(null, { status: 204 }));
  await assert.rejects(pending, (e) => {
    assert.ok(e instanceof SignInError);
    assert.equal(e.message, t("app.signIn.signedOutElsewhere"));
    return true;
  });
  await signedOutNow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    server.sent.map(line),
    [`POST ${SESSION}`, `GET ${SESSION}`, `DELETE ${SESSION}`],
    "no probes; the cookie may have been stored after the other tab's revocation went out",
  );
});

test("a sign-in answered after a sign-out elsewhere ends the session it set", async () => {
  closeSession();
  server.sent.length = 0;
  let answerSignIn!: (response: Response) => void;
  server.answer = answers({
    POST: () => new Promise<Response>((resolve) => (answerSignIn = resolve)),
  });
  const heard = await heardDuring(async () => {
    const pending = openSession("secret", false, hooks);
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelSignIns();
    answerSignIn(new Response(null, { status: 204 }));
    await assert.rejects(pending, (e) => {
      assert.ok(e instanceof SignInError);
      assert.equal(e.message, t("app.signIn.signedOutElsewhere"));
      return true;
    });
  });
  await signedOutNow();
  assert.deepEqual(server.sent.map(line), [
    `POST ${SESSION}`,
    `GET ${SESSION}`,
    `DELETE ${SESSION}`,
  ]);
  const revocation = server.sent[2];
  assert.equal(revocation.headers["X-Cook-Dashboard"], "1");
  assert.equal(revocation.headers.Authorization, undefined);
  assert.deepEqual(heard, [], "the other tabs already signed out");
});

/** What the other tabs hear on the sign-out channel while `work` runs. */
async function heardDuring(work: (heard: string[]) => Promise<void>) {
  const heard: string[] = [];
  const otherTab = new BroadcastChannel("cook-router.session");
  otherTab.onmessage = (event: MessageEvent) => heard.push(String(event.data));
  try {
    await work(heard);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    otherTab.close();
  }
  return heard;
}

test("a sign-out tells the other tabs only after the server confirmed it", async () => {
  server.sent.length = 0;
  let confirm!: (response: Response) => void;
  server.answer = answers({
    DELETE: () => new Promise<Response>((resolve) => (confirm = resolve)),
  });
  const heard = await heardDuring(async (heard) => {
    const out = revokeSession();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(server.sent.map(line), [`DELETE ${SESSION}`]);
    assert.deepEqual(heard, [], "nothing is told while the DELETE is pending");
    confirm(new Response(null, { status: 204 }));
    await out;
  });
  assert.deepEqual(heard, ["signed-out"]);
  // A 401 means the session had already ended: signed out all the same.
  server.answer = answers({
    DELETE: () => Response.json({ error: "invalid or expired session" }, { status: 401 }),
  });
  assert.deepEqual(await heardDuring(() => revokeSession()), ["signed-out"]);
});

test("a sign-out the server did not confirm fails and tells no tab", async () => {
  for (const answer of [
    () => Promise.reject(new TypeError("Failed to fetch")),
    () => Response.json({ error: "cross-site request refused" }, { status: 403 }),
    () => new Response(null, { status: 502 }),
  ]) {
    server.answer = answers({ DELETE: answer });
    const heard = await heardDuring(() => assert.rejects(revokeSession()));
    assert.deepEqual(heard, []);
  }
});

test("a revocation waits for the sign-out's last requests, and a sign-in waits for it", async () => {
  server.sent.length = 0;
  server.answer = answers({});
  let finish!: () => void;
  const last = new Promise<void>((resolve) => (finish = resolve));
  void revokeSession(last);
  const signIn = openSession("secret", false, hooks);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(server.sent.length, 0, "nothing goes out before the last request settles");
  finish();
  await signIn;
  assert.deepEqual(server.sent.slice(0, 3).map(line), [
    `DELETE ${SESSION}`,
    `POST ${SESSION}`,
    `GET ${SESSION}`,
  ]);
  assert.equal(server.sent[0].headers.Authorization, undefined);
});
