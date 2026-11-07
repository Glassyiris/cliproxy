import { defineTheme } from "@astryxdesign/core/theme";
import { palette } from "./sitePalette.generated.ts";

const { neutral, green, yellow, red, blue } = palette;
const alpha = (color: string, value: string) => `${color}${value}`;

// Status colours are written as [light, dark] pairs on solid stops so their contrast can be
// measured exactly: each text colour sits on the page background and on its own muted fill.
const status = {
  ready: { text: [green.light[30], green.dark[75]], fill: [green.light[90], green.dark[20]] },
  cooling: { text: [yellow.light[30], yellow.dark[80]], fill: [yellow.light[90], yellow.dark[20]] },
  failing: { text: [red.light[30], red.dark[80]], fill: [red.light[90], red.dark[20]] },
  info: { text: [blue.light[30], blue.dark[80]], fill: [blue.light[90], blue.dark[20]] },
} as const;

const pair = (value: readonly [string, string]) => `light-dark(${value[0]}, ${value[1]})`;

const latin =
  'Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial';
// The CJK half of the stack. zh-TW swaps it to Traditional first in document.css.
const cjkSimplified =
  '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "PingFang TC", "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif';

export const siteTheme = defineTheme({
  name: "site",

  typography: {
    scale: { base: 14, ratio: 1.2 },
    body: { family: "Figtree Variable", fallbacks: `${latin}, ${cjkSimplified}` },
    heading: { weight: "semibold" },
    code: {
      family: "JetBrains Mono",
      fallbacks: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    },
  },

  radius: { base: 4, multiplier: 1 },
  motion: { fast: 125, medium: 300, slow: 700, ratio: 0.75 },

  adaptations: {
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
  },

  tokens: {
    // Type: page title 24/600, section 18/600, body 14, supporting 13.
    "--text-heading-1-size": "1.5rem",
    "--text-heading-2-size": "1.125rem",
    "--text-supporting-size": "0.8125rem",

    // Body and surface share one background; cards and popovers step up one level.
    "--color-background-body": [neutral.light[97], neutral.dark[10]],
    "--color-background-surface": [neutral.light[97], neutral.dark[10]],
    "--color-background-card": [neutral.light[100], neutral.dark[15]],
    "--color-background-popover": [neutral.light[100], neutral.dark[15]],
    "--color-background-muted": [neutral.light[90], neutral.dark[20]],
    "--color-background-inverted": [neutral.light[10], neutral.dark[95]],

    // The primary action and the focus ring are ink, not a hue.
    "--color-accent": [neutral.light[10], neutral.dark[95]],
    "--color-accent-muted": [neutral.light[85], neutral.dark[30]],
    "--color-on-accent": [neutral.light[100], neutral.dark[5]],
    "--color-text-accent": [neutral.light[10], neutral.dark[95]],
    "--color-icon-accent": [neutral.light[10], neutral.dark[95]],
    "--focus-outline-color": "var(--color-accent)",
    "--color-neutral": [alpha(neutral.light[10], "0F"), alpha(neutral.dark[95], "1A")],

    "--color-overlay": [alpha(neutral.light[0], "80"), alpha(neutral.dark[0], "CC")],
    "--color-overlay-hover": [alpha(neutral.light[10], "0D"), alpha(neutral.dark[95], "0D")],
    "--color-overlay-pressed": [alpha(neutral.light[10], "1A"), alpha(neutral.dark[95], "1A")],

    "--color-text-primary": [neutral.light[10], neutral.dark[95]],
    "--color-text-secondary": [neutral.light[35], neutral.dark[65]],
    "--color-text-disabled": [neutral.light[60], neutral.dark[35]],
    "--color-icon-primary": [neutral.light[10], neutral.dark[95]],
    "--color-icon-secondary": [neutral.light[35], neutral.dark[65]],
    "--color-icon-disabled": [neutral.light[60], neutral.dark[35]],
    "--color-on-dark": neutral.light[100],
    "--color-on-light": neutral.light[10],

    "--color-border": [alpha(neutral.light[10], "1A"), alpha(neutral.dark[95], "1A")],
    "--color-border-emphasized": [neutral.light[80], neutral.dark[35]],
    "--color-skeleton": [neutral.light[90], neutral.dark[25]],
    "--color-track": [neutral.light[85], neutral.dark[30]],
    "--color-shadow": [alpha(neutral.light[0], "1A"), alpha(neutral.dark[0], "4D")],
    "--color-tint-hover": [neutral.light[10], neutral.dark[95]],

    // Status: ready = success, cooling = warning, failing = error, info = info.
    "--color-text-success": [...status.ready.text],
    "--color-text-warning": [...status.cooling.text],
    "--color-text-error": [...status.failing.text],
    "--color-text-info": [...status.info.text],
    "--color-on-success-muted": [...status.ready.text],
    "--color-on-warning-muted": [...status.cooling.text],
    "--color-on-error-muted": [...status.failing.text],
    "--color-on-info-muted": [...status.info.text],
    "--color-success-muted": [...status.ready.fill],
    "--color-warning-muted": [...status.cooling.fill],
    "--color-error-muted": [...status.failing.fill],
    "--color-info-muted": [...status.info.fill],
    "--color-success": [green.light[45], green.dark[65]],
    "--color-warning": [yellow.light[85], yellow.dark[75]],
    "--color-error": [red.light[45], red.dark[65]],
    "--color-info": [blue.light[45], blue.dark[65]],
    "--color-on-success": [neutral.light[100], neutral.dark[5]],
    "--color-on-warning": [neutral.light[10], neutral.dark[5]],
    "--color-on-error": [neutral.light[100], neutral.dark[5]],
    "--color-on-info": [neutral.light[100], neutral.dark[5]],
    "--color-background-error-inverted": [red.light[45], red.dark[65]],

    "--color-text-gray": [neutral.light[35], neutral.dark[65]],
    "--color-background-gray": [neutral.light[90], neutral.dark[20]],
  },

  components: {
    // The closed status vocabulary. A lamp always sits next to its word (StatusLamp).
    "status-dot": {
      "variant:ready": { backgroundColor: pair(status.ready.text), color: pair(status.ready.text) },
      "variant:cooling": {
        backgroundColor: pair(status.cooling.text),
        color: pair(status.cooling.text),
      },
      "variant:failing": {
        backgroundColor: pair(status.failing.text),
        color: pair(status.failing.text),
      },
      "variant:info": { backgroundColor: pair(status.info.text), color: pair(status.info.text) },
      "variant:disabled": {
        backgroundColor: "var(--color-text-disabled)",
        color: "var(--color-text-disabled)",
      },
    },
    text: {
      "color:ready": { color: pair(status.ready.text) },
      "color:cooling": { color: pair(status.cooling.text) },
      "color:failing": { color: pair(status.failing.text) },
      "color:info": { color: pair(status.info.text) },
    },
  },
});
