// Fixed sizes of the app frame, in the units the Astryx props take: numbers are pixels.
export const layout = {
  signInWidth: 400,
  pageWidth: 960,
  // BoothDex admin-shell widths: the sidebar opens at 260 and can be dragged between 220 and 360.
  sidebar: { defaultWidth: 260, minWidth: 220, maxWidth: 360 },
  valueSkeleton: { width: "8rem", height: "1em" },
  summaryTileMin: 150,
} as const;
