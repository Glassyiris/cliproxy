// One value for each role that repeats across pages, measured from the Astryx page templates the
// pages are built from. DESIGN.md "Roles" lists every role with its source and, where templates
// disagree, why this value won. Spacing and sizes inside one template's own composition (its gaps,
// a toolbar's `size="sm"`) stay as that template writes them and are not roles.
import { layout } from "./layout.ts";

export const roles = {
  // table-grouped:901, table-filter:4339 and dashboard-comparison:786 (the default inset),
  // table-inbox:2413.
  header: { padding: 4 },
  // table-filter:4480, table-inbox:2599, settings-sidebar:313. Lists and dashboards set no
  // contentWidth. Settings take settings-sidebar:303, whose width includes its own nav; a
  // single-column form takes form-wizard-inline:610.
  content: { padding: 4, settingsWidth: 1200, formWidth: 800 },
  // table-inbox:2628, table-grouped:953, table-page:933, dashboard-comparison:879.
  table: { density: "balanced" },
  // Every template's page title is level 1; dashboard-alert-rail:868 (section),
  // dashboard-alert-rail:782 (card title), dashboard-alert-rail:1317 (heading inside a card).
  heading: { page: 1, section: 2, card: 3, inCard: 4 },
  // The level sets a heading's scale, so no Heading takes `type`. Text types by use:
  // table-grouped:777 (content, cells), dashboard-alert-rail:1461 (the line under a title, hints),
  // dashboard-alert-rail:863 (field and metric labels), table-filter:3350 (metric values),
  // dashboard-comparison:389 (text inside another text). No assigned template shows identifiers;
  // `code` is the Text docs' type for them (model IDs, keys, paths, versions).
  textType: {
    body: "body",
    supporting: "supporting",
    label: "label",
    metric: "large",
    identifier: "code",
    nested: "inherit",
  },
  // The only Text size: the brand name on the sign-in card (login-card:94).
  textSize: { brand: "lg" },
  // dashboard-alert-rail:1098 (emphasis), login-card:94 and table-grouped:1001 (brand, group name),
  // table-inbox:1059 (the plain branch of a conditional emphasis). Headings take no weight.
  textWeight: { emphasis: "semibold", strong: "bold", plain: "normal" },
  // At most one per page, at the LayoutHeader's end (table-inbox:2434). Other header controls take
  // the default size as well (dashboard-comparison:795-818).
  primaryAction: { variant: "primary", size: "md" },
  // table-inbox:1008, table-filter:2159.
  rowAction: { variant: "ghost", size: "sm" },
  // table-filter:2229 beside the list; below `compactSurface` the detail is a BottomSheet
  // (table-filter:4313).
  detailPanel: layout.detailPanel,
  detailSheet: { height: "tall", padding: 0 },
  compactSurface: "(max-width: 768px), (max-width: 1024px) and (pointer: coarse) and (hover: none)",
} as const;
