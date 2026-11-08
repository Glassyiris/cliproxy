import assert from "node:assert/strict";
import { test } from "node:test";
import type { DefinedTheme } from "@astryxdesign/core/theme";
import { paletteLoader } from "./palettes.ts";
import { siteTheme } from "./site.js";

const main = { name: "site-main" } as DefinedTheme;

test("Moon needs no load", async () => {
  let calls = 0;
  const load = paletteLoader(() => (calls++, Promise.resolve(main)));
  assert.equal(await load("moon"), siteTheme);
  assert.equal(calls, 0);
});

test("Main loads once and is reused", async () => {
  let calls = 0;
  const load = paletteLoader(() => (calls++, Promise.resolve(main)));
  assert.equal(await load("main"), main);
  assert.equal(await load("main"), main);
  assert.equal(calls, 1);
});

test("a failed load settles as null and the next choice retries", async () => {
  let calls = 0;
  const load = paletteLoader(() =>
    ++calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(main),
  );
  assert.equal(await load("main"), null);
  assert.equal(await load("main"), main);
  assert.equal(calls, 2);
});
