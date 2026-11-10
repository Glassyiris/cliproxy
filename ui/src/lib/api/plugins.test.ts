import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeServer } from "./fakeServer.testSupport.ts";

const server = fakeServer();
// The client captures location on import, after the fake server installs it.
const { connect } = await import("./client.ts");
const { ConfigChangedError, revealResource } = await import("./config.ts");
const { replacePluginConfig, revealPluginConfig } = await import("./plugins.ts");
connect("management-key", { unauthorized() {}, server() {} });

const resource = { kind: "plugin", id: "imported", ord: 0, rev: 7, spec: "$secret" };
const written = { revision: 8, written: true, changes: [], restart_required: false };

test("imported plugin reveal and revision-checked edit exclude lossless YAML metadata", async () => {
  const editable = { enabled: true, token: "test-plugin-token", settings: { retries: 2 } };
  const raw = { baseline: editable, value: "!custom\nenabled: true\ntoken: test-plugin-token\n" };
  const exported = { ...resource, spec: { ...editable, "@raw-yaml": raw } };
  server.sent.length = 0;
  server.answer = ({ url }) => {
    if (url.pathname === "/admin/v1/export") return Response.json({ resources: [exported] });
    if (url.pathname === "/admin/v1/apply") return Response.json(written);
    return Response.json(resource);
  };

  const revealed = await revealPluginConfig(resource.id);
  assert.equal(revealed.rev, resource.rev);
  assert.deepEqual(revealed.spec, editable);
  // Backup exports retain the original envelope even after an editor reveal.
  assert.deepEqual((await revealResource("plugin", resource.id)).spec, exported.spec);

  const next = { ...editable, settings: { retries: 3 }, "@raw-yaml": raw };
  await replacePluginConfig(revealed, next);
  assert.deepEqual(server.sent.at(-1)?.body, {
    ops: [
      {
        op: "put",
        kind: "plugin",
        id: resource.id,
        if_rev: resource.rev,
        spec: { ...editable, settings: { retries: 3 } },
      },
    ],
  });
  assert.equal(server.sent.at(-1)?.url.pathname, "/admin/v1/apply");
  assert.deepEqual(next["@raw-yaml"], raw);
});

test("plugin null remains null through explicit reveal and replacement", async () => {
  server.sent.length = 0;
  server.answer = ({ url }) => {
    if (url.pathname === "/admin/v1/export")
      return Response.json({ resources: [{ ...resource, spec: null }] });
    if (url.pathname === "/admin/v1/apply") return Response.json(written);
    return Response.json(resource);
  };
  const revealed = await revealPluginConfig(resource.id);
  assert.equal(revealed.spec, null);
  await replacePluginConfig(revealed, null);
  assert.deepEqual(server.sent.at(-1)?.body, {
    ops: [{ op: "put", kind: "plugin", id: resource.id, if_rev: resource.rev, spec: null }],
  });
});

test("plugin reveal refuses a revision changed while exporting", async () => {
  server.sent.length = 0;
  let reads = 0;
  server.answer = ({ url }) => {
    if (url.pathname === "/admin/v1/export")
      return Response.json({ resources: [{ ...resource, spec: { enabled: true } }] });
    return Response.json({ ...resource, rev: resource.rev + reads++ });
  };
  await assert.rejects(revealPluginConfig(resource.id), ConfigChangedError);
  assert.equal(server.sent.length, 3);
  assert.ok(server.sent.every(({ method }) => method === "GET"));
});
