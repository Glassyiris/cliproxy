// Fixed sizes of the app frame, in the units the Astryx props take: numbers are pixels.
export const layout = {
  signInWidth: 400,
  // One label column for every MetadataList on a surface, so stacked lists line up their values
  // (About: facts and links). Fits "Remote management" and 程式碼儲存庫 at 15 px.
  metadataLabelWidth: 160,
  // Settings that take a number or a duration: wide enough for "300 seconds", not the whole column.
  shortControlWidth: 200,
  // card-v2 layout.ts SIDE_WIDTH: a side column of cards beside the main column.
  sideColumn: 340,
  // The phone breakpoint at which the page padding drops to 16 px: Astryx `md` (AppShell's phone
  // bar starts below it).
  phone: "(max-width: 47.99rem)",
  // The detail panel beside a list, as the table-filter template sizes it: wide enough for a
  // MetadataList's label column, narrow enough to leave the table its columns.
  detailPanel: { defaultSize: 380, minSize: 320, maxSize: 560 },
  // BoothDex admin-shell widths: the sidebar opens at 260 and can be dragged between 220 and 360.
  sidebar: { defaultWidth: 260, minWidth: 220, maxWidth: 360 },
  // The config editor dialog is the preferences dialog's size (owner, 2026-11-08: 「編輯器默認大小和
  // 設置的差不多把？」); its code box takes that height less the title rows, footer and padding,
  // and scrolls inside.
  codeEditor: { height: "calc(min(50rem, 100dvh - 2rem) - 11rem)" },
  // Menus and selectors show this many pixels of rows before scrolling; the viewport still bounds
  // them. Astryx caps at 300, which scrolled an eight-row menu on a tall screen (owner,
  // 2026-11-08: 「夠長的話其實不用那麼限高。」).
  menuMaxHeight: 640,
  // A list filter menu: wide enough for 需重新登入 or "Sign in again" and a three-digit count apart.
  filterMenuWidth: 240,
  // Icon size="sm" (Astryx 0.7.11): the empty slot that keeps a menu's counts in line with a check.
  smallIcon: 16,
  valueSkeleton: { width: "8rem", height: "1em" },
  summaryTileMin: 150,
  // The settings template's two columns, a Region's heading and its controls, are each at least
  // this wide; where both do not fit they stack.
  settingsColumnMin: 320,
  // Where the dashboard-alert-rail template folds its rail into the content: 1024px at the
  // default root size.
  railFolds: "(max-width: 64rem)",
  // The floor of a table column given a share (`proportional(n, { minWidth })`). The Table's own
  // floor for such a column is 120, which pushes a table of short columns wider than a phone or
  // the list beside an open panel; this is the floor it gives a column with no width.
  tableColumnFloor: 60,
  // A column holding one short value (Logs' time, request id and level), which needs 78 to 100 on
  // one line; a share of the width broke them where the list is narrow.
  shortValueColumn: 100,
  // The requests column of Accounts and Provider keys: the 200-minute count in a slot of five
  // tabular digits, then the 20 ten-minute bars at one width, so every row's count and timeline
  // start at the same x. The column holds both plus the cell's inline padding.
  requests: { count: "5ch", strip: 120, column: 200 },
  // A page hosted in a dialog (PageDialog) and the Use with a tool wizard: one height for every
  // step of a wizard, so the frame does not jump between steps; tall enough that Connect's longest
  // step, the list of ways, does not scroll at 1440x900, and the viewport less 2rem on a phone so
  // the footer stays on screen.
  // A header control that is not a button (the Usage live view Switch) sits in a button's height,
  // so it lines up with the h1 as the other pages' buttons do.
  headerControl: "var(--size-element-md)",
  pageDialog: { height: "min(40rem, calc(100dvh - 2rem))" },
  // The settings-dialog template's frame: 1120 x min(800, viewport less 2rem), one size for every
  // panel so the frame does not jump as panels change; below 40rem the side rail becomes a tab
  // strip (the template's 640px).
  settingsDialog: {
    width: 1120,
    height: "min(50rem, calc(100dvh - 2rem))",
    narrowViewport: "(max-width: 40rem)",
    // SideNavHeading's own row height, so the hand-set title lines up with the nav labels.
    headingRow: 32,
    // The column the pinned close button floats over, so a long description wraps before it.
    closeColumn: 32,
    // Palette tiles: at least this wide each (the template's 96 holds one picture; a palette tile
    // holds a light and a dark half), and the group capped so the pictures stay controls.
    previewMin: 160,
    previewsMax: 480,
  },
} as const;
