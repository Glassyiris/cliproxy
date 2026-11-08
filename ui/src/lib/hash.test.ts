import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redirect } from "./hash.ts";

test("current hashes stay", () => {
  for (const hash of ["", "#", "#overview", "#accounts?show=attention", "#activity/7?view=logs"])
    assert.equal(redirect(hash), null);
});

test("a page that became a tab keeps its argument and query", () => {
  assert.equal(redirect("#providers?family=codex"), "#accounts?family=codex&view=providers");
  assert.equal(redirect("#logs/req-1?tab=errors"), "#activity/req-1?tab=errors&view=logs");
  assert.equal(redirect("#config/routing"), "#settings/routing");
  assert.equal(redirect("#keys"), "#clients");
  assert.equal(redirect("#quotas"), "#accounts");
});

test("a page that became a dialog opens it on its route", () => {
  assert.equal(redirect("#use?tool=codex"), "#clients?tool=codex&open=use");
  assert.equal(
    redirect("#plugins/my%20plugin?store=1"),
    "#settings?store=1&open=plugins&plugin=my+plugin",
  );
});

test("connect and about open over the page shown before", () => {
  assert.equal(
    redirect("#connect", "#accounts?show=attention"),
    "#accounts?show=attention&open=connect",
  );
  assert.equal(redirect("#oauth", "#accounts/a.json"), "#accounts/a.json?open=connect");
  assert.equal(redirect("#system", "#models"), "#models?open=about");
  // Nothing shown yet, or the page before was itself an old hash: Overview.
  assert.equal(redirect("#connect"), "#overview?open=connect");
  assert.equal(redirect("#connect", "#connect"), "#overview?open=connect");
});

test("a malformed plugin escape is read as written", () => {
  for (const arg of ["%", "%E0%A4%A", "a%2Fb%"])
    assert.equal(
      redirect(`#plugins/${arg}`),
      `#settings?open=plugins&plugin=${encodeURIComponent(arg)}`,
    );
});
