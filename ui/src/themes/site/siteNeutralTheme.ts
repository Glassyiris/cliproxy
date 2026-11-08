import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";
import { siteAdaptations, siteSizes, siteTypography } from "./siteTheme.ts";

/**
 * "Neutral": Astryx's neutral theme with its own colours, light and dark, for anyone who finds
 * Rosé Pine too colourful (owner, 2026-11-09). The site's sizes, type scale and motion rule are
 * added, and a few colours from neutral's own values (one from core): the grey for bars and chart
 * volume, and warning in neutral's orange instead of its bright yellow (owner, 2026-11-09:
 * 「不太中性感覺」「難看的配色」). Every other colour token is neutral's theme.css or core's
 * astryx.css default. Built to site-neutral.*, loaded on demand.
 */
export const siteNeutralTheme = defineTheme({
  name: "site-neutral",
  extends: neutralTheme,
  typography: siteTypography,
  adaptations: siteAdaptations,
  tokens: {
    ...siteSizes,
    // The one colour changed (owner, 2026-11-09): in neutral's dark mode a ProgressBar's fill
    // (--color-text-disabled) and track (--color-border-emphasized) are both #525252, so a quota
    // bar showed no value. The fill takes neutral's seed grey, #777777; the track stays, since it
    // is also every input's outline. Light keeps neutral's #919191.
    "--color-text-disabled": ["#919191", "#777777"],
    // Chart volume takes the same greys as the quota bar fill above (core's blue-grey
    // light-dark(#8494A3, #8C939B) read as tinted): 3.15:1 on the light card, 3.85:1 dark.
    "--color-data-neutral": ["#919191", "#777777"],
    // Warning is neutral's orange family, soft fill and dark ink like a muted badge, so a waiting
    // badge, cooling dot or warning banner is quiet beside the greys. Source values in comments.
    "--color-warning": ["#ffc7a1", "#503424"], // was #ffce2f; neutral --color-background-orange
    "--color-on-warning": ["#622700", "#ffb37e"], // was #111111; neutral --color-text-orange
    "--color-warning-muted": ["#ffc7a1", "#503424"], // was light-dark(#fae19e, #e2b6233D); background-orange
    "--color-on-warning-muted": ["#622700", "#ffb37e"], // was light-dark(#4b3900, #eec448); text-orange
    "--color-text-warning": ["#622700", "#ffb37e"], // was light-dark(#836700, #eec448); text-orange
    // Icons and status dots: neutral's light orange icon (#622700) is near-black beside the red
    // dot, so light takes core's --color-data-orange-4 (3.77:1 on white); dark is neutral's.
    "--color-icon-warning": ["#d66100", "#ff9e55"], // was var(--color-text-warning); icon-orange
  },
});
