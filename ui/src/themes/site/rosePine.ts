// The Rosé Pine palette, copied unmodified from github.com/rose-pine/palette (MIT,
// https://rosepinetheme.com): the twelve named roles from `palette.json`, the three highlight
// roles from `dist/css/rose-pine.css`, which `palette.json` does not carry. The two files disagree
// on Dawn's text (#464261 and #575279); `palette.json` is used.

export type RosePineVariant = {
  base: string;
  surface: string;
  overlay: string;
  muted: string;
  subtle: string;
  text: string;
  love: string;
  gold: string;
  rose: string;
  pine: string;
  foam: string;
  iris: string;
  highlightLow: string;
  highlightMed: string;
  highlightHigh: string;
};

export const main: RosePineVariant = {
  base: "#191724",
  surface: "#1f1d2e",
  overlay: "#26233a",
  muted: "#6e6a86",
  subtle: "#908caa",
  text: "#e0def4",
  love: "#eb6f92",
  gold: "#f6c177",
  rose: "#ebbcba",
  pine: "#31748f",
  foam: "#9ccfd8",
  iris: "#c4a7e7",
  highlightLow: "#21202e",
  highlightMed: "#403d52",
  highlightHigh: "#524f67",
};

export const moon: RosePineVariant = {
  base: "#232136",
  surface: "#2a273f",
  overlay: "#393552",
  muted: "#6e6a86",
  subtle: "#908caa",
  text: "#e0def4",
  love: "#eb6f92",
  gold: "#f6c177",
  rose: "#ea9a97",
  pine: "#3e8fb0",
  foam: "#9ccfd8",
  iris: "#c4a7e7",
  highlightLow: "#2a283e",
  highlightMed: "#44415a",
  highlightHigh: "#56526e",
};

export const dawn: RosePineVariant = {
  base: "#faf4ed",
  surface: "#fffaf3",
  overlay: "#f2e9e1",
  muted: "#9893a5",
  subtle: "#797593",
  text: "#464261",
  love: "#b4637a",
  gold: "#ea9d34",
  rose: "#d7827e",
  pine: "#286983",
  foam: "#56949f",
  iris: "#907aa9",
  highlightLow: "#f4ede8",
  highlightMed: "#dfdad9",
  highlightHigh: "#cecacd",
};
