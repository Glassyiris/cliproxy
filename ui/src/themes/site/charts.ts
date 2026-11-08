import * as stylex from "@stylexjs/stylex";

// The charts module's colours and geometry (src/components/charts/). Series colours are theme
// variables that recharts takes as fill and stroke: volume is the data neutral (DESIGN.md
// "Colour": neutral volume) and failures are the error status colour, love.
export const series = {
  volume: "var(--color-data-neutral)",
  failed: "var(--color-error)",
} as const;

// A legend swatch, one per series above: lucide's square filled with the series colour,
// as the dashboard templates draw it with a solid square icon.
export const swatch = stylex.create({
  volume: { color: "var(--color-data-neutral)", fill: "var(--color-data-neutral)" },
  failed: { color: "var(--color-error)", fill: "var(--color-error)" },
});

// The chart geometry: the margin that keeps the tallest y-label and the centred end ticks from
// clipping (dashboard-alert-rail). Recharts takes numbers as px.
export const chartGeometry = {
  margin: { top: 12, right: 16, left: 0, bottom: 4 },
  tick: { fontSize: "var(--font-size-sm)", fill: "var(--color-text-secondary)" },
  grid: "var(--color-border)",
  cursor: "var(--color-tint-hover)",
  minTickGap: 16,
} as const;

// The plot box. It clips its content: the focused recharts SVG fills it, so the browser's own
// focus outline around the SVG is cut off and only the Astryx ring around the box shows (recharts
// sets the SVG's style itself, so the outline cannot be turned off on the SVG).
export const chartPlot = stylex.create({
  // The nbcards admin's fixed plot height (card-v2 TrendChart.tsx): 14rem, 12rem on a phone (the
  // media query is layout.phone; StyleX takes only a literal key).
  traffic: {
    height: { default: "14rem", "@media (max-width: 47.99rem)": "12rem" },
    width: "100%",
    overflow: "hidden",
  },
  // A bar list: one band per source and room for the value axis under them, so it grows with its
  // rows rather than squeezing them into the fixed height.
  sources: (rows: number) => ({
    height: `calc(${rows} * 2.25rem + 2rem)`,
    width: "100%",
    overflow: "hidden",
  }),
});
