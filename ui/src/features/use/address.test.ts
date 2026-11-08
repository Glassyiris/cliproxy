import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalHost, toolTarget } from "./address.ts";

test("local names are recognised and others are not", () => {
  for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1"])
    assert.equal(isLocalHost(host), true, host);
  for (const host of ["proxy.example.com", "192.168.1.5", "localhost.example.com", "[::2]"])
    assert.equal(isLocalHost(host), false, host);
});

test("only Cursor on a local address gets the public placeholder", () => {
  const base = "http://localhost:8317";
  assert.equal(toolTarget("Cursor", base, true), "https://your-public-address");
  assert.equal(toolTarget("Cursor", base, false), base);
  assert.equal(toolTarget("curl", base, true), base);
});
