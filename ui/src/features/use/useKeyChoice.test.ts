import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientKey } from "../../lib/api/clientKeys.ts";

// Load the API boundary only after supplying the page address it reads at module initialization.
Object.assign(globalThis, { location: { href: "http://cpa.test/management.html" } });
const { selectedClientKey, selectedPlaintext } = await import("./useKeyChoice.ts");

const first: ClientKey = { id: "client-a", ord: 0, rev: 2, spec: { key: "$secret" } };
const second: ClientKey = { id: "client-b", ord: 1, rev: 3, spec: { key: "$secret" } };

test("client selection follows resource IDs through reordering and deletion", () => {
  assert.equal(selectedClientKey([first, second], second.id), second);
  assert.equal(selectedClientKey([second, first], second.id), second);
  assert.equal(selectedClientKey([second], second.id), second);
  assert.equal(selectedClientKey([first], second.id), first);
  assert.equal(selectedClientKey([first, second], "1"), first);
  assert.equal(selectedClientKey(undefined, second.id), undefined);
  assert.equal(selectedClientKey([], second.id), undefined);
});

test("masked listings never supply plaintext, even before a reveal", () => {
  assert.equal(selectedPlaintext(first, undefined), "");
  assert.equal(selectedPlaintext(first, { id: first.id, rev: first.rev, key: "$secret" }), "");
  assert.equal(selectedPlaintext(first, { id: first.id, rev: first.rev, key: "" }), "");
});

test("plaintext belongs only to the revealed resource revision", () => {
  const revealed = { id: second.id, rev: second.rev, key: "sk-client-b" };
  assert.equal(selectedPlaintext(second, revealed), "sk-client-b");
  assert.equal(selectedPlaintext(first, revealed), "");
  assert.equal(selectedPlaintext({ ...second, rev: second.rev + 1 }, revealed), "");
  assert.equal(selectedPlaintext(undefined, revealed), "");
});
