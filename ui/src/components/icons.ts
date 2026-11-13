// One icon per meaning, so a verb or a thing shows the same glyph on every page: the actions on
// buttons, and the things the side nav, section headings and empty states name. Lucide, the
// neutral theme's own set; a string is the theme's semantic name. Tables of one surface (Overview's
// attention reasons, the settings panels) keep their own maps; provider marks are ProviderIcon.tsx.
import type { IconProps } from "@astryxdesign/core/Icon";
import {
  Activity,
  Ban,
  Boxes,
  Braces,
  ChartBarDecreasing,
  ChartColumn,
  CircleCheck,
  Download,
  Key,
  KeyRound,
  Layers,
  LayoutDashboard,
  Plug,
  Plus,
  Radio,
  RefreshCw,
  Save,
  ScrollText,
  Send,
  ServerCog,
  Trash2,
  Users,
} from "lucide-react";

export const icons = {
  // actions
  add: Plus,
  refresh: RefreshCw,
  download: Download,
  delete: Trash2,
  save: Save,
  test: Send,
  use: Plug,
  exclude: Ban,
  allow: CircleCheck,
  search: "search",
  // things
  all: Layers,
  overview: LayoutDashboard,
  accounts: Users,
  providerKeys: Key,
  clientKeys: KeyRound,
  models: Boxes,
  payload: Braces,
  activity: Activity,
  traffic: ChartColumn,
  sources: ChartBarDecreasing,
  live: Radio,
  logs: ScrollText,
  server: ServerCog,
  settings: "wrench",
  attention: "warning",
  allClear: "success",
} as const satisfies Record<string, IconProps["icon"]>;
