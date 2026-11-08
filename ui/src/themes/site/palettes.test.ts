import assert from "node:assert/strict";
import { test } from "node:test";
import type { DefinedTheme } from "@astryxdesign/core/theme";
import { defaultPalette, paletteLoader } from "./palettes.ts";
import { siteNeutralTheme } from "./site-neutral.js";

const moon = { name: "site" } as DefinedTheme;
const main = { name: "site-main" } as DefinedTheme;

/** A loader whose themes count their loads; `fail` rejects that palette's first load. */
function counting(fail?: "moon" | "main") {
  const calls = { moon: 0, main: 0 };
  const load = paletteLoader({
    moon: () =>
      ++calls.moon === 1 && fail === "moon"
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(moon),
    main: () =>
      ++calls.main === 1 && fail === "main"
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(main),
  });
  return { load, calls };
}

test("Neutral is the default and needs no load", async () => {
  const { load, calls } = counting();
  assert.equal(defaultPalette, "neutral");
  assert.equal(await load("neutral"), siteNeutralTheme);
  assert.deepEqual(calls, { moon: 0, main: 0 });
});

test("each other palette loads its own theme once and reuses it", async () => {
  const { load, calls } = counting();
  assert.equal(await load("moon"), moon);
  assert.equal(await load("moon"), moon);
  assert.equal(await load("main"), main);
  assert.equal(await load("main"), main);
  assert.deepEqual(calls, { moon: 1, main: 1 });
});

test("a failed load settles as null and the next choice retries", async () => {
  const { load, calls } = counting("moon");
  assert.equal(await load("moon"), null);
  assert.equal(await load("moon"), moon);
  assert.equal(calls.moon, 2);
});

test("a failed load leaves the other palettes' loads alone", async () => {
  const { load, calls } = counting("main");
  assert.equal(await load("moon"), moon);
  assert.equal(await load("main"), null);
  assert.equal(await load("moon"), moon);
  assert.equal(await load("main"), main);
  assert.deepEqual(calls, { moon: 1, main: 2 });
});
