import assert from "node:assert/strict";

// Intentionally restricted to a disposable local backend. Never point this at production.
const base = "http://127.0.0.1:8317";
const key = "orb-dashboard-test-only";
let checks = 0;
let lastEtag;
async function call(path, method = "GET", body, expected = 200, extraHeaders = {}) {
  const headers = { Authorization: `Bearer ${key}`, ...extraHeaders };
  if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(base + (path.startsWith("/admin/v1/") ? path : "/v8/management" + path), {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const content = await response.text();
  lastEtag = response.headers.get("etag");
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${content.slice(0, 200)}`,
  );
  console.log(`${response.status} ${method} ${path.split("?")[0]}`);
  checks++;
  return content ? JSON.parse(content) : {};
}

const readConfig = async (path = "") => path.split("/").filter(Boolean).reduce((value, key) => value?.[key], await call("/admin/v1/effective/config"));
const apply = (ops, expected = 200) => call("/admin/v1/apply", "POST", { ops }, expected);
const setConfig = async (path, value, expected = 200) => apply([{ op: "set", path, value, expect: (await readConfig(path)) ?? null }], expected);
const config = await readConfig();
// The credential store sits beside the database, which the disposable backend keeps here.
assert.ok(
  String((await call("/admin/v1/credentials")).auth_dir).startsWith("/tmp/cooker-backend/"),
  "Not the disposable backend. Refusing mutations.",
);
const backup = await call("/admin/v1/export?include_secrets=true");
let uploaded = false;
try {
  await call("/credentials");
  await call("/observability/usage/api-keys");
  await call("/observability/usage/queue?count=50");
  await call("/server/latest-version");
  const upstream = await call("/requests/api-call", "POST", {
    method: "GET",
    url: base + "/healthz",
  });
  assert.equal(upstream.status_code, 200);
  assert.equal(JSON.parse(upstream.body).status, "ok");

  await setConfig("routing/retry/request-retry", 0);
  assert.equal(await readConfig("routing/retry/request-retry"), 0);
  await setConfig("routing/strategy", "fill-first");
  assert.equal(await readConfig("routing/strategy"), "fill-first");
  await setConfig("routing/session-affinity", true);
  assert.equal((await readConfig()).routing["session-affinity"], true);
  await apply([{ op: "unset", path: "routing/session-affinity", expect: true }]);
  await setConfig("routing/retry/request-retry", { value: 4 }, 422);
  assert.equal(
    await readConfig("routing/retry/request-retry"),
    0,
    "Rejected write changed state.",
  );

  await setConfig("access/api-keys", []);
  const clientId = "dashboard-disposable-client";
  const createClient = { op: "put", kind: "client-key", id: clientId, spec: { key: "orb-client-test-only" }, if_absent: true };
  await apply([createClient]);
  await apply([createClient], 412);
  const clients = (await call("/admin/v1/r/client-key")).items;
  const client = clients.find(({ id }) => id === clientId);
  assert.ok(client?.rev);
  assert.equal(client.spec.key, "$secret");
  assert.deepEqual(await readConfig("access/api-keys"), [{ "@id": clientId, key: "$secret" }]);
  assert.deepEqual(await call(`/admin/v1/r/client-key/${clientId}`), client);
  const maskedExport = await call("/admin/v1/export");
  assert.equal(maskedExport.resources.find(({ kind, id }) => kind === "client-key" && id === clientId).spec.key, "$secret");
  const revealedExport = await call("/admin/v1/export?include_secrets=true");
  assert.equal(revealedExport.resources.find(({ kind, id }) => kind === "client-key" && id === clientId).spec.key, "orb-client-test-only");
  await apply([{ op: "delete", kind: "client-key", id: clientId, if_rev: client.rev - 1 }], 412);
  await apply([{ op: "delete", kind: "client-key", id: clientId, if_rev: client.rev }]);
  await call(`/admin/v1/r/client-key/${clientId}`, "GET", undefined, 404);
  for (const family of [
    "claude",
    "codex",
    "gemini",
    "vertex",
    "openai-compatibility",
    "interactions",
    "xai",
    "meta",
  ]) {
    const group = {
      name: "disposable",
      "base-url": base,
      "excluded-models": ["*"],
      keys: [{ "api-key": "not-a-provider-credential" }],
    };
    if (family === "openai-compatibility") {
      delete group["excluded-models"];
      group.disabled = true;
      group.models = [{ name: "test-model", alias: "test-model" }];
    }
    await setConfig(`api-keys/${family}`, [group]);
    assert.equal(
      (await readConfig(`api-keys/${family}`))[0].name,
      "disposable",
    );
    await setConfig(`api-keys/${family}`, []);
  }
  await setConfig("oauth/model-alias/claude", [
    { name: "claude-sonnet-4-5", alias: "daily-driver", fork: true },
  ]);
  assert.equal(
    (await readConfig("oauth/model-alias/claude"))[0].alias,
    "daily-driver",
  );
  await setConfig("oauth/excluded-models/claude", ["*-preview"]);
  await call("/routing/model-definitions/claude");
  for (const kind of [
    "default",
    "default-raw",
    "override",
    "override-raw",
    "filter",
  ]) {
    await setConfig(`requests/payload/${kind}`, [
      {
        models: [{ name: "*", protocol: "openai" }],
        params:
          kind === "filter"
            ? ["metadata"]
            : { temperature: kind.endsWith("-raw") ? "0.7" : 0.7 },
      },
    ]);
    assert.equal((await readConfig(`requests/payload/${kind}`)).length, 1);
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob(
      [
        JSON.stringify({
          type: "dashboard-test",
          email: "test@example.test",
          disabled: true,
          refresh_token: "synthetic-not-a-real-token",
        }),
      ],
      { type: "application/json" },
    ),
    "dashboard-test.json",
  );
  await call("/credentials", "POST", form);
  uploaded = true;
  let credential = (
    await call("/credentials?name=dashboard-test.json")
  ).files.find((a) => a.name === "dashboard-test.json");
  assert.ok(credential);
  await call("/credentials/download?name=dashboard-test.json");
  await call("/credentials/status", "PATCH", {
    name: credential.name,
    auth_index: credential.auth_index,
    disabled: false,
  });
  assert.equal(
    (await call("/credentials?name=dashboard-test.json")).files[0].disabled,
    false,
  );
  await call("/credentials/fields", "PATCH", {
    name: credential.name,
    note: "Disposable test",
    priority: 7,
  });
  assert.equal(
    (await call("/credentials?name=dashboard-test.json")).files[0].note,
    "Disposable test",
  );
  await call("/credentials/models?name=dashboard-test.json");
  await call("/routing/cooldown/reset", "POST", {
    auth_index: credential.auth_index,
  });
  const refresh = await call("/credentials/refresh", "POST", { all: true });
  assert.ok(refresh.ok);
  assert.ok(
    refresh.results.some((r) => r.success === false),
    "Synthetic provider must not claim token refresh success.",
  );
  await call("/credentials", "DELETE", { names: ["dashboard-test.json"] });
  uploaded = false;

  for (const provider of ["codex", "claude"]) {
    const login = await call(
      `/oauth/auth-url?provider=${provider}&is_webui=true`,
    );
    assert.ok(new URL(login.url).protocol === "https:");
    assert.equal(
      (await call(`/oauth/status?state=${login.state}`)).status,
      "wait",
    );
    await call("/oauth/callback", "POST", {
      provider,
      state: login.state,
      error: "access_denied",
    });
    await call(`/oauth/session?state=${login.state}`, "DELETE");
  }
  const invalidImport = new FormData();
  invalidImport.append(
    "file",
    new Blob(["{}"], { type: "application/json" }),
    "invalid.json",
  );
  await call("/oauth/import?provider=vertex", "POST", invalidImport, 400);
  const log = await call("/observability/logs?limit=20");
  assert.ok(Array.isArray(log.lines));
  const incremental = await call(
    `/observability/logs?limit=20&cursor=${encodeURIComponent(log["next-cursor"] || "")}`,
  );
  assert.ok(Array.isArray(incremental.lines));
  await call("/observability/logs/errors");
  await call(
    "/observability/logs/requests/no-such-test-request",
    "GET",
    undefined,
    404,
  );
  console.log(
    `PASS: ${checks} endpoint checks, including write/readback, rejection, OAuth start/poll/callback/cancel, credential CRUD, and cursor logs.`,
  );
} finally {
  if (uploaded)
    await call("/credentials", "DELETE", { names: ["dashboard-test.json"] });
  await readConfig();
  assert.match(lastEtag ?? "", /^"\d+"$/, "restore needs the current global ETag");
  await call("/admin/v1/import", "POST", backup, 200, { "If-Match": lastEtag });
  const restored = await readConfig();
  for (const section of [
    "server",
    "management",
    "access",
    "routing",
    "observability",
  ]) {
    const check = (before, after) => {
      for (const [name, value] of Object.entries(before)) {
        if (value && typeof value === "object" && !Array.isArray(value))
          check(value, after[name]);
        else
          assert.deepEqual(
            after[name],
            value,
            `Restore failed for ${section}.${name}`,
          );
      }
    };
    check(config[section], restored[section]);
  }
  assert.equal(Object.values(restored["api-keys"] || {}).flat().length, 0);
  console.log(
    "PASS: original disposable settings restored from the admin export.",
  );
}
