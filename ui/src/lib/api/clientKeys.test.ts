import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeServer } from "./fakeServer.testSupport.ts";

const server = fakeServer();
const { connect } = await import("./client.ts");
// The fake server must install location before the client reads its module-level base URL.
const { ConfigChangedError, patchResource, readResource, replaceResource, revealProviderKey } =
  await import("./config.ts");
const { createClientKey, deleteClientKey, listClientKeys, revealClientKey } =
  await import("./clientKeys.ts");
const { listClientModels } = await import("./proxy.ts");
connect("management-key", { unauthorized() {}, server() {} });

const written = { revision: 4, written: true, changes: [], restart_required: false };
const resource = {
  kind: "client-key",
  id: "client-stable",
  ord: 0,
  rev: 3,
  spec: { key: "$secret" },
};

test("ordinary client listing does not request a plaintext export", async () => {
  server.sent.length = 0;
  server.answer = () => Response.json({ items: [resource] });
  assert.deepEqual(await listClientKeys(), { items: [resource] });
  assert.deepEqual(
    server.sent.map(({ url }) => url.pathname),
    ["/admin/v1/r/client-key"],
  );
});

test("client creation and deletion use resource identity and revision", async () => {
  server.sent.length = 0;
  server.answer = () => Response.json(written);
  await createClientKey("new-client-key");
  const creation = server.sent[0].body as {
    ops: { kind: string; id: string; spec: unknown; if_absent: boolean }[];
  };
  assert.equal(creation.ops[0].kind, "client-key");
  assert.ok(creation.ops[0].id);
  assert.equal(creation.ops[0].if_absent, true);
  assert.deepEqual(creation.ops[0].spec, { key: "new-client-key" });
  await deleteClientKey(resource);
  assert.deepEqual(server.sent[1].body, {
    ops: [{ op: "delete", kind: "client-key", id: resource.id, if_rev: resource.rev }],
  });
});

test("explicit reveal joins client and provider child identities, not list positions", async () => {
  server.sent.length = 0;
  server.answer = () =>
    Response.json({
      resources: [
        { kind: "client-key", id: "other", spec: { key: "wrong" } },
        {
          kind: "provider",
          id: "provider-stable",
          spec: {
            keys: [
              { "@id": "other-child", "api-key": "wrong-provider-key" },
              { "@id": "child-stable", "api-key": "actual-provider-key" },
            ],
          },
        },
        { kind: "client-key", id: resource.id, spec: { key: "actual-client-key" } },
      ],
    });
  assert.equal(await revealClientKey(resource.id), "actual-client-key");
  assert.equal(await revealProviderKey("provider-stable", "child-stable"), "actual-provider-key");
  assert.ok(
    server.sent.every(
      ({ url }) =>
        url.pathname === "/admin/v1/export" && url.searchParams.get("include_secrets") === "true",
    ),
  );
  await assert.rejects(revealProviderKey("provider-stable", "gone-child"), ConfigChangedError);
});

test("resource writes reject a stale revision without retry", async () => {
  server.sent.length = 0;
  server.answer = () => Response.json(resource);
  assert.deepEqual(await readResource("client-key", resource.id), resource);
  server.answer = () => Response.json({ error: "precondition_failed" }, { status: 412 });
  await assert.rejects(deleteClientKey(resource), ConfigChangedError);
  await assert.rejects(replaceResource(resource, { key: "rotated-key" }), ConfigChangedError);
  assert.equal(server.sent.length, 3);
});

test("masked or empty values cannot become a client credential", async () => {
  server.sent.length = 0;
  for (const key of ["", "$secret"]) {
    assert.throws(() => createClientKey(key), ConfigChangedError);
    await assert.rejects(listClientModels(key), ConfigChangedError);
  }
  assert.equal(server.sent.length, 0);
  server.answer = () =>
    Response.json({
      resources: [{ kind: "client-key", id: resource.id, spec: { key: "$secret" } }],
    });
  await assert.rejects(revealClientKey(resource.id), ConfigChangedError);
});

test("masked plugin switches patch by revision without revealing their spec", async () => {
  server.sent.length = 0;
  server.answer = () => Response.json(written);
  const plugin = { kind: "plugin", id: "plugin-stable", ord: 0, rev: 7, spec: "$secret" };
  await patchResource(plugin, { enabled: false });
  assert.equal(server.sent.length, 1);
  assert.equal(server.sent[0].url.pathname, "/admin/v1/apply");
  assert.deepEqual(server.sent[0].body, {
    ops: [{ op: "patch", kind: "plugin", id: plugin.id, patch: { enabled: false }, if_rev: 7 }],
  });
});
