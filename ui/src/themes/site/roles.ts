// One value for each role that repeats across pages. Sizes and spacing come from the nbcards admin
// (card-v2, MIT, the owner's project; measured in p3/r/ref/nbcards/REPORT.md): its `web/src/ui/
// layout.ts` spacing constants, `PageFrame.tsx` page frame and `UI-RULES.md` heading levels, cards
// and buttons. The Astryx templates the pages are built from settle the rest. DESIGN.md "Roles"
// lists every role with its source. Spacing inside one template's own composition (a toolbar's
// `size="sm"`) stays as that template writes it and is not a role.
import { layout } from "./layout.ts";

export const roles = {
  // card-v2 PageFrame.tsx: padding 6 on Layout (24 px; 4 on a phone), set once so the header and
  // the content share one line and the h1 sits at the same place on every page; the body ends with
  // paddingBlockEnd 10 (40 px). Unlike card-v2 the content line is not capped at 1440: on a wide
  // screen the cap left empty bands on both sides (owner, 2026-11-08: 「留空太多了？」).
  page: { padding: 6, phonePadding: 4, bottomPadding: 10 },
  // card-v2 layout.ts: SECTION_GAP between a page's sections, CARD_GAP between cards and between
  // blocks inside one card, CARD_PADDING the one Card padding.
  gap: { section: 6, card: 4 },
  card: { padding: 5 },
  // Reading pages (settings, forms) cap their content: settings-sidebar:303, form-wizard-inline:610.
  content: { settingsWidth: 1200, formWidth: 800 },
  // table-inbox:2628, table-grouped:953, table-page:933, dashboard-comparison:879.
  table: { density: "balanced" },
  // card-v2 UI-RULES.md "Page": h1 the page, h2 SectionHeading outside cards, h3 CardHeading inside,
  // h4 a sub-block. Never two headings stacked.
  heading: { page: 1, section: 2, card: 3, inCard: 4 },
  // The level sets a heading's scale, so no Heading takes `type`. Text types by use:
  // table-grouped:777 (content, cells), dashboard-alert-rail:1461 (the line under a title, hints),
  // dashboard-alert-rail:863 (field and metric labels), card-v2 MetricCard.tsx (metric values,
  // display-3: 31/600), dashboard-comparison:389 (text inside another text); `code` is the Text
  // docs' type for identifiers (model IDs, keys, paths, versions).
  textType: {
    body: "body",
    supporting: "supporting",
    label: "label",
    metric: "display-3",
    identifier: "code",
    nested: "inherit",
  },
  // The only Text size: the brand name on the sign-in card (login-card:94).
  textSize: { brand: "lg" },
  // dashboard-alert-rail:1098 (emphasis), login-card:94 and table-grouped:1001 (brand, group name),
  // table-inbox:1059 (the plain branch of a conditional emphasis). Headings take no weight.
  textWeight: { emphasis: "semibold", strong: "bold", plain: "normal" },
  // card-v2 UI-RULES.md "Buttons": one primary per view, default size (36 px with the theme's
  // control sizes), at the header's end; other header controls default size too.
  primaryAction: { variant: "primary", size: "md" },
  // Row actions are ghost sm (32 px): table-inbox:1008, table-filter:2159, card-v2 UI-RULES.md.
  rowAction: { variant: "ghost", size: "sm" },
  // table-filter:2229 beside the list; below `compactSurface` the detail is a BottomSheet
  // (table-filter:4313).
  detailPanel: layout.detailPanel,
  detailSheet: { height: "tall", padding: 0 },
  compactSurface: "(max-width: 768px), (max-width: 1024px) and (pointer: coarse) and (hover: none)",
} as const;
