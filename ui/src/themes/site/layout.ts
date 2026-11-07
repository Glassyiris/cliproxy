// Fixed sizes of the app frame, in the units the Astryx props take: numbers are pixels.
export const layout = {
  signInWidth: 400,
  pageWidth: 960,
  // The detail panel beside a list, as the table-filter template sizes it: wide enough for a
  // MetadataList's label column, narrow enough to leave the table its columns.
  detailPanel: { defaultSize: 380, minSize: 320, maxSize: 560 },
  // BoothDex admin-shell widths: the sidebar opens at 260 and can be dragged between 220 and 360.
  sidebar: { defaultWidth: 260, minWidth: 220, maxWidth: 360 },
  // Lines the config editor shows before it scrolls, as the legacy editor had.
  editorRows: 22,
  valueSkeleton: { width: "8rem", height: "1em" },
  summaryTileMin: 150,
} as const;
