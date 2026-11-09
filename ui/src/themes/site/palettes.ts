import type { DefinedTheme } from "@astryxdesign/core/theme";
import { siteNeutralTheme } from "./site-neutral.js";

/**
 * The three palettes, independent of light and dark: Neutral (Astryx's own colours, the default)
 * for both modes, and Moon and Main for dark with Dawn for light.
 */
const palettes = ["neutral", "moon", "main"] as const;
export type Palette = (typeof palettes)[number];
const neutral = "neutral";
export const defaultPalette: Palette = neutral;
/** The default palette's theme, in the entry. */
export const defaultTheme: DefinedTheme = siteNeutralTheme;
export const isPalette = (value: unknown): value is Palette => palettes.includes(value as Palette);

type Loaders = Record<Exclude<Palette, typeof neutral>, () => Promise<DefinedTheme>>;

/**
 * The theme of a palette. Neutral is in the entry; every other palette loads once, on first use.
 * A failed load settles as null (the caller shows Neutral) and is forgotten, so the next choice
 * tries again.
 */
export function paletteLoader(loaders: Loaders) {
  const loads = new Map<Palette, Promise<DefinedTheme | null>>();
  return (palette: Palette): Promise<DefinedTheme | null> => {
    if (palette === neutral) return Promise.resolve(defaultTheme);
    let load = loads.get(palette);
    if (!load) {
      load = loaders[palette]().then(
        (theme) => theme,
        () => null,
      );
      void load.then((theme) => {
        if (!theme) loads.delete(palette);
      });
      loads.set(palette, load);
    }
    return load;
  };
}

// The one table keyed by palette name: which module holds each on-demand theme.
export const loadPalette = paletteLoader({
  moon: () => import("./siteMoon.ts").then((m) => m.siteTheme),
  main: () => import("./siteMain.ts").then((m) => m.siteMainTheme),
});
