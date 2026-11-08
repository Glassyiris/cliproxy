import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { IconProps } from "@astryxdesign/core/Icon";
import {
  Boxes,
  Braces,
  ChartColumn,
  Key,
  KeyRound,
  LayoutDashboard,
  Plug,
  PlugZap,
  Puzzle,
  ScrollText,
  Info,
  Users,
} from "lucide-react";
import { t } from "../lib/i18n.ts";

export type NavGroup = "overview" | "traffic" | "observe" | "server";

/** Side navigation sections, in order. A section with no page is not shown. */
export const navGroups: readonly { id: NavGroup; title(): string }[] = [
  { id: "overview", title: () => t("app.navGroup.overview") },
  { id: "traffic", title: () => t("app.navGroup.traffic") },
  { id: "observe", title: () => t("app.navGroup.observe") },
  { id: "server", title: () => t("app.navGroup.server") },
];

export type PageRoute = {
  /** The hash segment: `#system`. */
  id: string;
  group: NavGroup;
  title(): string;
  /** A semantic icon name from the theme or an icon component. */
  icon: IconProps["icon"];
  page: LazyExoticComponent<ComponentType>;
  /** Not a nav item: while this page is open, the item with this id is the selected one. */
  selects?: string;
};

/** A page chunk failed to load. React.lazy keeps the rejection, so only a reload fetches it again. */
export class PageLoadError extends Error {}

function page(load: () => Promise<{ default: ComponentType }>) {
  return lazy(() =>
    load().catch((cause: unknown) => {
      throw new PageLoadError("Page chunk failed to load", { cause });
    }),
  );
}

// The navigation lists these in this order, grouped by `group`; the first one is the landing page.
export const routes: readonly PageRoute[] = [
  {
    id: "overview",
    group: "overview",
    title: () => t("app.nav.overview"),
    icon: LayoutDashboard,
    page: page(() => import("../features/overview/index.ts")),
  },
  {
    id: "use",
    group: "overview",
    title: () => t("app.nav.use"),
    icon: Plug,
    page: page(() => import("../features/use/index.ts")),
  },
  {
    id: "accounts",
    group: "traffic",
    title: () => t("app.nav.accounts"),
    icon: Users,
    page: page(() => import("../features/accounts/index.ts")),
  },
  {
    id: "providers",
    group: "traffic",
    title: () => t("app.nav.providers"),
    icon: KeyRound,
    page: page(() => import("../features/providers/index.ts")),
  },
  {
    id: "keys",
    group: "traffic",
    title: () => t("app.nav.keys"),
    icon: Key,
    page: page(() => import("../features/keys/index.ts")),
  },
  {
    id: "models",
    group: "traffic",
    title: () => t("app.nav.models"),
    icon: Boxes,
    page: page(() => import("../features/models/index.ts")),
  },
  {
    id: "payload",
    group: "traffic",
    title: () => t("app.nav.payload"),
    icon: Braces,
    page: page(() => import("../features/payload/index.ts")),
  },
  {
    id: "usage",
    group: "observe",
    title: () => t("app.nav.usage"),
    icon: ChartColumn,
    page: page(() => import("../features/usage/index.ts")),
  },
  {
    id: "logs",
    group: "observe",
    title: () => t("app.nav.logs"),
    icon: ScrollText,
    page: page(() => import("../features/logs/index.ts")),
  },
  {
    id: "config",
    group: "server",
    title: () => t("app.nav.config"),
    icon: "wrench",
    page: page(() => import("../features/config/index.ts")),
  },
  {
    id: "plugins",
    group: "server",
    title: () => t("app.nav.plugins"),
    icon: Puzzle,
    page: page(() => import("../features/plugins/index.ts")),
  },
  {
    id: "system",
    group: "server",
    title: () => t("app.nav.system"),
    icon: Info,
    page: page(() => import("../features/system/index.ts")),
  },
  // Reached from Overview and Accounts, as in the legacy dashboard; the command palette lists it.
  {
    id: "connect",
    group: "traffic",
    title: () => t("app.nav.connect"),
    icon: PlugZap,
    page: page(() => import("../features/connect/index.ts")),
    selects: "accounts",
  },
];

// Hashes of the legacy dashboard, so old links still land: Credentials and Quotas became Accounts.
const aliases: Record<string, string> = {
  oauth: "connect",
  configuration: "config",
  credentials: "accounts",
  quotas: "accounts",
};

/**
 * The page a hash names, the rest of its path and its query (`#accounts/<id>?provider=codex`); an
 * unknown or empty hash opens the first page. `path` is the hash before the query, as written.
 */
export function parseHash(hash: string) {
  const raw = hash.slice(1);
  const mark = raw.indexOf("?");
  const path = mark < 0 ? raw : raw.slice(0, mark);
  let value = path;
  try {
    value = decodeURIComponent(path);
  } catch {
    // A malformed escape is read as written.
  }
  const [id = "", ...rest] = value.split("/");
  const name = aliases[id] ?? id;
  return {
    route: routes.find((r) => r.id === name) ?? routes[0],
    arg: rest.join("/"),
    path,
    params: Object.fromEntries(new URLSearchParams(mark < 0 ? "" : raw.slice(mark + 1))),
  };
}
