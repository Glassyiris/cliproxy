// The site theme as the app loads it: the built module and stylesheet from `astryx theme build
// src/themes/site/siteTheme.ts` (rerun after editing siteTheme.ts or upgrading Astryx), its fonts,
// and the document rules the theme cannot express.
import "@fontsource-variable/figtree/index.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "./site.css";
import "./document.css";

export { siteTheme } from "./site.js";

/** The closed status vocabulary of DESIGN.md. Each is a StatusDot variant and, except disabled, a Text colour. */
export type Status = "ready" | "cooling" | "failing" | "info" | "disabled";
