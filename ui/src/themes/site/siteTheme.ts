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

  // The primary action is ink (text on base). Links are body text, as the nbcards admin draws
  // them (card-v2 siteTheme.ts sets the text accent to its ink); a chevron, the hover and the
  // button shape show what is clickable. Iris is the focus ring only.
  "--color-accent": mode("text"),
  "--color-accent-muted": mode("overlay"),
  "--color-on-accent": mode("base"),
  "--color-text-accent": mode("text"),
  "--color-icon-accent": mode("text"),
  "--focus-outline-color": mode("iris"),
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

const neutralSans =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * card-v2's `panelScale`: base 15, ratio 1.2, so body 15, card title 18, section 22, page title 26
 * and metric value 31. `typography` replaces neutral's block whole, so its fonts are repeated as
 * neutral writes them; headings 3 and 4 are semibold, not neutral's bold (weights 400/500/600).
 */
export const siteTypography: ThemeConfig["typography"] = {
  scale: { base: 15, ratio: 1.2 },
  body: { family: "Figtree", fallbacks: neutralSans },
  heading: { family: "Figtree", fallbacks: neutralSans, weights: { 3: "semibold", 4: "semibold" } },
  // Liberation Mono and Courier New are Courier's metrics and look like it; the common Linux, Windows
  // and editor monos come first so a desktop without SF Mono or Consolas does not land on them
  // (owner, 2026-11-08, of the config editor and the account panel: 「也太難看了」).
  code: {
    family: "ui-monospace",
    fallbacks:
      '"SF Mono", Menlo, "Cascadia Code", Consolas, "JetBrains Mono", "Fira Code", "Noto Sans Mono", "DejaVu Sans Mono", "Liberation Mono", monospace',
  },
};

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

/**
 * Sizes from the nbcards admin (card-v2 `web/src/themes/shared/index.ts` `panelShared`, and the
 * radii of `web/src/themes/site/siteTheme.ts`; MIT, the owner's project): controls one 4 px step up
 * (sm 32 row actions and icon buttons, md 36 buttons and inputs, lg 40), supporting text 13 on a
 * 20 px line, and radius 8 / 12 / 16 (inner, element, card). The metric value (display-3, 31 px)
 * is semibold, as card-v2's MetricCard draws it.
 */
const sizeTokens = {
  "--size-element-sm": "32px",
  "--size-element-md": "36px",
  "--size-element-lg": "40px",
  "--text-supporting-size": "0.8125rem",
  "--text-supporting-leading": "1.5385",
  "--radius-inner": "0.5rem",
  "--radius-element": "0.75rem",
  "--radius-container": "1rem",
  "--text-display-3-weight": "var(--font-weight-semibold)",
};

/** The colour and size tokens for one Rosé Pine dark variant; light is always Dawn. */
export const roseTokens = (dark: RosePineVariant) => {
  const r = roles(dark);
  return {
    ...sizeTokens,
    ...chromeTokens(r, dark),
    ...statusTokens(r),
    ...dataTokens(r),
  };
};

/**
 * The site theme, built twice: Moon (the default, this file) and Main (siteMainTheme.ts, loaded on
 * demand). Both extend Astryx's neutral theme and set tokens and the type scale only: fonts,
 * components, icons (lucide) and motion come from neutral, so no Astryx component carries a style of this
 * app's own. Each file calls defineTheme itself: the build follows `extends` to carry neutral's
 * icon registry only through a direct defineTheme call.
 */
export const siteTheme = defineTheme({
  name: "site",
  extends: neutralTheme,
  typography: siteTypography,
  adaptations: siteAdaptations,
  tokens: roseTokens(moon),
});
