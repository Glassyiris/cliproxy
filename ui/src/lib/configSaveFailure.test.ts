import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeServer } from "./api/fakeServer.testSupport.ts";
import type { ConfigSaveFailure } from "./configSaveFailure.ts";

const server = fakeServer();
// The page address must exist before the API client initializes its module-level base URL.
const { ApiError, connect } = await import("./api/client.ts");
const { replaceConfigValue } = await import("./api/config.ts");
const { configSaveFailure } = await import("./configSaveFailure.ts");
connect({ unauthorized() {}, server() {} });

test("destination rejection names every secret field and retains the unsaved JSON edits", async () => {
  const draft =
    '{\n  "@id": "provider-a",\n  "base-url": "https://new.example",\n  "keys": [{"@id":"key-a","api-key":"$secret"}]\n}';
  const pointers = ["/keys/0/api-key", "/headers/Authorization"];
  server.sent.length = 0;
  server.answer = () =>
    Response.json(
      {
        error: "secret_destination_changed",
        resource: "provider/provider-a",
        pointer: pointers[0],
        pointers,
        message: "Fresh secrets required",
      },
      { status: 422 },
    );
  let rejected: ConfigSaveFailure | null = null;
  try {
    await replaceConfigValue("api-keys/claude", [], JSON.parse(draft));
    assert.fail("destination change must be rejected");
  } catch (error) {
    assert.ok(error instanceof ApiError);
    assert.deepEqual(error.pointers, pointers);
    assert.equal(error.pointer, pointers[0]);
    assert.equal(error.resource, "provider/provider-a");
    rejected = configSaveFailure(error, draft);
  }
  assert.ok(rejected);
  assert.equal(
    rejected.message,
    "Re-enter the secret at each of these fields in provider/provider-a to change where it is sent: /keys/0/api-key, /headers/Authorization. Your JSON edits are kept.",
  );
  assert.equal(rejected.draft, draft);
  assert.equal(server.sent.length, 1, "a rejection must not retry or reveal stored secrets");
});
