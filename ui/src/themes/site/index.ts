// The site theme as the app loads it: the built module and stylesheet from `astryx theme build
// src/themes/site/siteTheme.ts` (rerun after editing siteTheme.ts or upgrading Astryx), neutral's font,
// and the document rules the theme cannot express. Neutral's fonts.css imports Figtree from Google
// Fonts at runtime; the same faces (the weights it requests) come from Fontsource instead, so the
// dashboard makes no third-party request.
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "./site.css";
import "./document.css";

export { siteTheme } from "./site.js";
export { defaultPalette, isPalette, loadPalette, type Palette } from "./palettes.ts";

/** The closed lamp vocabulary of DESIGN.md; StatusLamp maps each to a StatusDot variant. */
export type Status = "ready" | "cooling" | "failing" | "disabled";
