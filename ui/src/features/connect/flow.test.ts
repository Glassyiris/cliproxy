import assert from "node:assert/strict";
import { test } from "node:test";
import type { Credential } from "../../lib/api/credentials.ts";
import { forgottenAccount, isWebAddress, signedInAccount, signInUrl, type Seen } from "./flow.ts";

const page = "https://host.example/prefix/management.html#connect";

test("a sign-in link resolves against the page and keeps only http and https", () => {
  assert.equal(
    signInUrl("./v0/resource/oauth/x#state=a", page),
    "https://host.example/prefix/v0/resource/oauth/x#state=a",
  );
  assert.equal(signInUrl("/v0/x", page), "https://host.example/v0/x");
  assert.equal(signInUrl("http://auth.example/a", page), "http://auth.example/a");
  for (const raw of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "mailto:a@b"])
    assert.equal(signInUrl(raw, page), null, raw);
  assert.equal(signInUrl("http://[bad", page), null);
});

test("a pasted callback address is an absolute http or https URL", () => {
  assert.ok(isWebAddress("http://localhost:1455/auth/callback?code=a&state=b"));
  assert.ok(isWebAddress("https://host.example/cb?code=a"));
  for (const raw of [
    "",
    "localhost:1455/cb",
    "/cb?code=a",
    "javascript:alert(1)",
    "mailto:a@b",
    "file:///etc/passwd",
  ])
    assert.equal(isWebAddress(raw), false, raw);
});

const cred = (name: string, type: string, updated_at = "2026-11-01T00:00:00Z") =>
  ({ name, type, provider: type, updated_at }) as Credential;
const seenOf = (...list: Credential[]): Seen => new Map(list.map((c) => [c.name, c]));
const old = cred("old.json", "claude");

test("a forgotten sign-in counts only one new name of exactly its built-in provider", () => {
  const fresh = cred("new.json", "claude");
  assert.equal(forgottenAccount("claude", seenOf(old), [old, fresh]), fresh);
  assert.equal(
    forgottenAccount("claude", seenOf(old), [old, fresh, cred("b.json", "claude")]),
    null,
  );
  assert.equal(forgottenAccount("claude", seenOf(old), [old, cred("k.json", "kimi")]), null);
  assert.equal(forgottenAccount("demo-oauth", seenOf(), [cred("p.json", "demo-oauth")]), null);
  assert.equal(forgottenAccount("claude", null, [fresh]), null);
  assert.equal(forgottenAccount("claude", seenOf(old), null), null);
  // A rewritten file is not a new account.
  assert.equal(
    forgottenAccount("claude", seenOf(old), [cred("old.json", "claude", "later")]),
    null,
  );
});

test("a confirmed sign-in names the one new account, else the one rewritten", () => {
  const fresh = cred("new.json", "claude");
  const rewritten = cred("old.json", "claude", "2026-11-08T00:00:00Z");
  assert.equal(signedInAccount("claude", seenOf(old), [old, fresh]), fresh);
  assert.equal(signedInAccount("claude", seenOf(old), [rewritten]), rewritten);
  assert.equal(signedInAccount("claude", seenOf(old), [rewritten, fresh]), fresh);
  assert.equal(signedInAccount("claude", seenOf(old), [old]), null);
  assert.equal(
    signedInAccount("claude", seenOf(old), [old, fresh, cred("c.json", "claude")]),
    null,
  );
  assert.equal(signedInAccount("demo-oauth", seenOf(), [cred("p.json", "demo-oauth")]), null);
});
