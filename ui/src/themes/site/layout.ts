// Fixed sizes of the app frame, in the units the Astryx props take: numbers are pixels.
export const layout = {
  signInWidth: 400,
  pageWidth: 960,
  sidebar: { defaultWidth: 232, minWidth: 200, maxWidth: 320 },
  valueSkeleton: { width: "8rem", height: "1em" },
} as const;
