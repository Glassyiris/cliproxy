import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { IconProps } from "@astryxdesign/core/Icon";
import {
  Activity,
  Boxes,
  Braces,
  ChartColumn,
  Key,
  KeyRound,
  LayoutDashboard,
  ScrollText,
  ServerCog,
  Users,
} from "lucide-react";
import { t } from "../lib/i18n.ts";

type RouteView = { id: string; title(): string; icon: IconProps["icon"] };

export type PageRoute = {
  /** The hash segment: `#accounts`. */
  id: string;
  title(): string;
  /** A semantic icon name from the theme or an icon component. */
  icon: IconProps["icon"];
  page: LazyExoticComponent<ComponentType>;
  /**
   * The pages grouped under this route in the side nav, each `#<id>?view=<view>`; the first has
   * no `?view=`. A route with views is a collapsible category; one without is a single item.
   */
  views?: readonly RouteView[];
  /** The side-nav category this route sits in when it is not its own (clients sit under Server). */
  navGroup?: string;
  /** The route's item in its own category when that differs from the category's title. */
  navTitle?: () => string;
  /** The category's icon when the route's own icon marks its item. */
  groupIcon?: IconProps["icon"];
  /** Fetches the page's chunk ahead of the first visit. */
  preload(): Promise<unknown>;
};

/** A page chunk failed to load. React.lazy keeps the rejection, so only a reload fetches it again. */
export class PageLoadError extends Error {}

function page(load: () => Promise<{ default: ComponentType }>) {
  return {
    page: lazy(() =>
      load().catch((cause: unknown) => {
        throw new PageLoadError("Page chunk failed to load", { cause });
      }),
    ),
    // A failed prefetch is retried by the visit itself, which reports it.
    preload: () => load().catch(() => undefined),
  };
}

// The side nav, in order; the first route is the landing page. A route with views is a collapsible
// category whose pages are `?view=` of it (owner, 2026-11-08: 「側邊欄可以做之前那種收起」, after the
// header tabs read as 「切換太離譜了」); dialogs are `?open=`. Old hashes land there (src/lib/hash.ts).
export const routes: readonly PageRoute[] = [
  {
    id: "overview",
    title: () => t("app.nav.overview"),
    icon: LayoutDashboard,
    ...page(() => import("../features/overview/index.ts")),
  },
  {
    id: "accounts",
    title: () => t("app.nav.accounts"),
    icon: Users,
    views: [
      { id: "accounts", title: () => t("app.nav.accounts"), icon: Users },
      { id: "providers", title: () => t("app.nav.providers"), icon: Key },
    ],
    ...page(() => import("./pages/AccountsPage.tsx")),
  },
  {
    id: "clients",
    title: () => t("app.nav.clients"),
    navGroup: "settings",
    navTitle: () => t("keys.page.title"),
    icon: KeyRound,
    ...page(() => import("./pages/ClientsPage.tsx")),
  },
  {
    id: "models",
    title: () => t("app.nav.models"),
    icon: Boxes,
    views: [
      { id: "models", title: () => t("app.nav.models"), icon: Boxes },
      { id: "payload", title: () => t("app.nav.payload"), icon: Braces },
    ],
    ...page(() => import("./pages/ModelsPage.tsx")),
  },
  {
    id: "activity",
    title: () => t("app.nav.activity"),
    icon: Activity,
    views: [
      { id: "usage", title: () => t("app.nav.usage"), icon: ChartColumn },
      { id: "logs", title: () => t("app.nav.logs"), icon: ScrollText },
    ],
    ...page(() => import("./pages/ActivityPage.tsx")),
  },
  {
    id: "settings",
    title: () => t("app.nav.settings"),
    navTitle: () => t("app.nav.config"),
    groupIcon: ServerCog,
    icon: "wrench",
    ...page(() => import("./pages/SettingsPage.tsx")),
  },
];

/** "Go to page" lists the pages and, under them, their tabs and dialogs. */
export const destinations: readonly { hash: string; route: string; title(): string }[] = [
  ...routes.map((r) => ({ hash: `#${r.id}`, route: r.id, title: () => r.title() })),
  { hash: "#accounts?view=providers", route: "accounts", title: () => t("app.nav.providers") },
  { hash: "#connect", route: "accounts", title: () => t("app.nav.connect") },
  { hash: "#clients?open=use", route: "clients", title: () => t("app.nav.use") },
  { hash: "#models?view=payload", route: "models", title: () => t("app.nav.payload") },
  { hash: "#activity?view=logs", route: "activity", title: () => t("app.nav.logs") },
  { hash: "#settings?open=plugins", route: "settings", title: () => t("app.nav.plugins") },
  { hash: "#system", route: "settings", title: () => t("app.nav.system") },
];

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
  return {
    route: routes.find((r) => r.id === id) ?? routes[0],
    arg: rest.join("/"),
    path,
    params: Object.fromEntries(new URLSearchParams(mark < 0 ? "" : raw.slice(mark + 1))),
  };
}
