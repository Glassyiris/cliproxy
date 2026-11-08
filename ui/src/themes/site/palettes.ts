import type { DefinedTheme } from "@astryxdesign/core/theme";
import { siteTheme } from "./site.js";

/** The two palettes, independent of light and dark: Moon (the default) and Main for dark, Dawn for light. */
const palettes = ["moon", "main"] as const;
export type Palette = (typeof palettes)[number];
export const defaultPalette: Palette = "moon";
export const isPalette = (value: unknown): value is Palette => palettes.includes(value as Palette);

/**
 * The theme of a palette. Moon is in the entry; Main loads once, on first use. A failed load
 * settles as null (the caller shows Moon) and is forgotten, so the next choice tries again.
 */
export function paletteLoader(loadMain: () => Promise<DefinedTheme>) {
  let mainLoad: Promise<DefinedTheme | null> | undefined;
  return (palette: Palette): Promise<DefinedTheme | null> => {
    if (palette === "moon") return Promise.resolve(siteTheme);
    if (!mainLoad) {
      const load = loadMain().then(
        (theme) => theme,
        () => null,
      );
      void load.then((theme) => {
        if (!theme) mainLoad = undefined;
      });
      mainLoad = load;
    }
    return mainLoad;
  };
}

export const loadPalette = paletteLoader(() =>
  import("./siteMain.ts").then((m) => m.siteMainTheme),
);
