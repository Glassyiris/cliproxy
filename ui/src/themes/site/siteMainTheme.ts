import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";
import { main } from "./rosePine.ts";
import { roseTokens, siteAdaptations, siteTypography } from "./siteTheme.ts";

/** "Rosé Pine": Main for dark, Dawn for light. Built to site-main.*, loaded on demand. */
export const siteMainTheme = defineTheme({
  name: "site-main",
  extends: neutralTheme,
  typography: siteTypography,
  adaptations: siteAdaptations,
  tokens: roseTokens(main),
});
