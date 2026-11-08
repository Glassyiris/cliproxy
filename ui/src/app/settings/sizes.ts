// The settings-dialog template's fixed sizes, in the units the Astryx props take (numbers are
// pixels). They belong in src/themes/site/layout.ts beside the other frame sizes.
export const settingsSizes = {
  // One frame for every panel: the template's 1120 × min(800, viewport less 2rem). A dialog sizes
  // to its content, so without a stated height the frame jumps as the panels change.
  dialogWidth: 1120,
  dialogHeight: "min(50rem, calc(100dvh - 2rem))",
  // Below this the side rail becomes a tab strip (the template's 640px).
  narrowViewport: "(max-width: 40rem)",
  // SideNavHeading's own row height, so the hand-set title lines up with the nav labels.
  headingRow: 32,
  // The column the pinned close button floats over, so a long description wraps before it.
  closeColumn: 32,
  // Palette tiles: at least this wide each (the template's 96 holds one picture; a palette tile
  // holds a light and a dark half), and the group capped so the pictures stay controls.
  previewMin: 160,
  previewsMax: 480,
} as const;
