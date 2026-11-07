import * as stylex from "@stylexjs/stylex";

// TrafficStrip's buckets, drawn as the dashboard-alert-rail template draws UptimeStrip's days:
// equal boxes in a row, no radius at this width. Volume takes the neutral fills, lightest to
// darkest; only a bucket with failures takes love (DESIGN.md "Colour").
export const traffic = stylex.create({
  bucket: { flexBasis: 0, flexGrow: 1, minWidth: "3px", height: "16px" },
  level0: { backgroundColor: "var(--color-track)" },
  level1: { backgroundColor: "var(--color-border-emphasized)" },
  level2: { backgroundColor: "var(--color-icon-disabled)" },
  level3: { backgroundColor: "var(--color-icon-secondary)" },
  level4: { backgroundColor: "var(--color-icon-primary)" },
  failed: { backgroundColor: "var(--color-error)" },
});
