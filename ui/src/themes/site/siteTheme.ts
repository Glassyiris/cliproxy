import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";
import { dawn, moon, type RosePineVariant } from "./rosePine.ts";

type Pair = [light: string, dark: string];

/** Rosé Pine roles as [light, dark] pairs, and the status vocabulary of DESIGN.md mapped to them. */
function roles(dark: RosePineVariant) {
  const mode = (role: keyof RosePineVariant): Pair => [dawn[role], dark[role]];
  // ready = pine, cooling = gold, failing = love, info = foam (Rosé Pine's own usage table).
  const status = {
    ready: mode("pine"),
    cooling: mode("gold"),
    failing: mode("love"),
    info: mode("foam"),
  };
  return { mode, status };
}

type Roles = ReturnType<typeof roles>;

/** Surfaces, text, borders and the accent. */
const chromeTokens = ({ mode }: Roles, dark: RosePineVariant) => ({
  // base behind the page; surface for cards and the side nav; overlay for popovers.
  "--color-background-body": mode("base"),
  "--color-background-surface": mode("surface"),
  "--color-background-card": mode("surface"),
  "--color-background-popover": mode("overlay"),
  "--color-background-muted": mode("overlay"),
  "--color-background-inverted": mode("text"),

  // The primary action is ink (text on base); links, focus ring and the current page are iris.
  "--color-accent": mode("text"),
  "--color-accent-muted": mode("overlay"),
  "--color-on-accent": mode("base"),
  "--color-text-accent": mode("iris"),
  "--color-icon-accent": mode("iris"),
  "--focus-outline-color": "var(--color-text-accent)",
  // Hover and selected nav rows and neutral badges sit on base or surface, where highlight low
  // is invisible (1.01 to 1.12:1), so they take highlight med.
  "--color-neutral": mode("highlightMed"),

  "--color-text-primary": mode("text"),
  "--color-text-secondary": mode("subtle"),
  "--color-text-disabled": mode("muted"),
  "--color-icon-primary": mode("text"),
  "--color-icon-secondary": mode("subtle"),
  "--color-icon-disabled": mode("muted"),
  "--color-on-dark": dark.text,
  "--color-on-light": dawn.text,

  "--color-border": mode("highlightMed"),
  "--color-border-emphasized": mode("highlightHigh"),
  "--color-skeleton": mode("highlightMed"),
  "--color-track": mode("highlightMed"),
  "--color-tint-hover": mode("highlightLow"),
});

/** The status vocabulary as text, icons, borders and fills. */
const statusTokens = ({ mode, status }: Roles) => ({
  // Status: ready = success, cooling = warning, failing = error, info = info. Text and icons
  // take the hue; muted fills (banners, badges) are overlay with hue text.
  "--color-text-success": status.ready,
  "--color-text-warning": status.cooling,
  "--color-text-error": status.failing,
  "--color-text-info": status.info,
  "--color-icon-success": status.ready,
  "--color-icon-warning": status.cooling,
  "--color-icon-error": status.failing,
  "--color-icon-info": status.info,
  "--color-border-success": status.ready,
  "--color-border-warning": status.cooling,
  "--color-border-error": status.failing,
  "--color-border-info": status.info,
  "--color-on-success-muted": status.ready,
  "--color-on-warning-muted": status.cooling,
  "--color-on-error-muted": status.failing,
  "--color-on-info-muted": status.info,
  "--color-success-muted": mode("overlay"),
  "--color-warning-muted": mode("overlay"),
  "--color-error-muted": mode("overlay"),
  "--color-info-muted": mode("overlay"),
  "--color-success": status.ready,
  "--color-warning": status.cooling,
  "--color-error": status.failing,
  "--color-info": status.info,
  "--color-on-success": mode("base"),
  "--color-on-warning": mode("base"),
  "--color-on-error": mode("base"),
  "--color-on-info": mode("base"),
  "--color-background-error-inverted": status.failing,

  "--color-text-gray": mode("subtle"),
  "--color-icon-gray": mode("subtle"),
  "--color-border-gray": mode("highlightMed"),
  "--color-background-gray": mode("overlay"),

  // Red and yellow are the failing and cooling hues, so a red or yellow Token (log levels) is
  // the error or warning colour, drawn like a badge: the hue on overlay.
  "--color-text-red": status.failing,
  "--color-icon-red": status.failing,
  "--color-border-red": status.failing,
  "--color-background-red": mode("overlay"),
  "--color-text-yellow": status.cooling,
  "--color-icon-yellow": status.cooling,
  "--color-border-yellow": status.cooling,
  "--color-background-yellow": mode("overlay"),
});

/**
 * Astryx's data tokens (`dataVars`) as Rosé Pine colours. Rosé Pine has six accents for ten
 * categorical names, so each name takes its nearest hue and pairs share one; a chart picks
 * distinct Rosé Pine hues, not distinct names. The sequential ramps are not set: Rosé Pine has no
 * ramps and no chart here uses one.
 */
const dataTokens = ({ mode }: Roles) => ({
  "--color-data-neutral": mode("subtle"),
  "--color-data-categorical-blue": mode("pine"),
  "--color-data-categorical-green": mode("pine"),
  "--color-data-categorical-cyan": mode("foam"),
  "--color-data-categorical-teal": mode("foam"),
  "--color-data-categorical-purple": mode("iris"),
  "--color-data-categorical-indigo": mode("iris"),
  "--color-data-categorical-red": mode("love"),
  "--color-data-categorical-pink": mode("rose"),
  "--color-data-categorical-orange": mode("gold"),
  "--color-data-categorical-brown": mode("gold"),
});

type ThemeConfig = Parameters<typeof defineTheme>[0];

export const siteAdaptations: ThemeConfig["adaptations"] = {
  rules: [
    // Reduced motion turns motion off, not down: Astryx alone still fades for up to 200 ms.
    {
      when: { motion: "reduce" },
      value: {
        tokens: {
          "--duration-fast-min": "0ms",
          "--duration-fast": "0ms",
          "--duration-fast-max": "0ms",
          "--duration-medium-min": "0ms",
          "--duration-medium": "0ms",
          "--duration-medium-max": "0ms",
          "--duration-slow-min": "0ms",
          "--duration-slow": "0ms",
          "--duration-slow-max": "0ms",
        },
      },
    },
  ],
};

/** The colour and type tokens for one Rosé Pine dark variant; light is always Dawn. */
export const roseTokens = (dark: RosePineVariant) => {
  const r = roles(dark);
  return {
    // Type: page title 24/600, section 18/600, body 14, supporting 13.
    "--text-heading-1-size": "1.5rem",
    "--text-heading-2-size": "1.125rem",
    "--text-supporting-size": "0.8125rem",
    ...chromeTokens(r, dark),
    ...statusTokens(r),
    ...dataTokens(r),
  };
};

/**
 * The site theme, built twice: Moon (the default, this file) and Main (siteMainTheme.ts, loaded on
 * demand). Both extend Astryx's neutral theme and set tokens only: fonts, components, icons
 * (lucide), radius and motion come from neutral, so no Astryx component carries a style of this
 * app's own. Each file calls defineTheme itself: the build follows `extends` to carry neutral's
 * icon registry only through a direct defineTheme call.
 */
export const siteTheme = defineTheme({
  name: "site",
  extends: neutralTheme,
  adaptations: siteAdaptations,
  tokens: roseTokens(moon),
});
