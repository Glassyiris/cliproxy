import { createElement, lazy, useState, type ComponentType } from "react";
import type { IconProps } from "@astryxdesign/core/Icon";
import { icons } from "../components/icons.ts";
import { t } from "../lib/i18n.ts";
import { PageLoadError, pageChunks, type Chunk } from "./chunks.ts";

type RouteView = { id: string; title(): string; icon: IconProps["icon"] };

export type PageRoute = {
  /** The hash segment: `#accounts`. */
  id: string;
  title(): string;
  /** A semantic icon name from the theme or an icon component. */
  icon: IconProps["icon"];
  page: ComponentType;
  /** The route's pages, each `#<id>?view=<view>`; the first has no `?view=`. */
  views?: readonly RouteView[];
  /** The route's side-nav item when that differs from its title. */
  navTitle?: () => string;
  preload(): Promise<unknown>;
};

function page(source: Chunk<{ default: ComponentType }>) {
  const Lazy = lazy(() =>
    source.load().catch((cause: unknown) => {
      throw new PageLoadError("Page chunk failed to load", { cause });
    }),
  );
  // A chunk already in renders at once (chunks.ts); the choice is kept for the visit, so a chunk
  // arriving later does not remount the page.
  function Page() {
    const [shown] = useState(() => source.loaded()?.default ?? Lazy);
    return createElement(shown);
  }
  return {
    page: Page,
    // A failed prefetch is retried by the visit itself, which reports it.
    preload: () => source.load().catch(() => undefined),
  };
}

// The pages; the first route is the landing page. A route's pages are `?view=` of it and dialogs
// are `?open=`. Old hashes land there (src/lib/hash.ts). The side nav groups them in `navSections`.
export const routes: readonly PageRoute[] = [
  {
    id: "overview",
    title: () => t("app.nav.overview"),
    icon: icons.overview,
    ...page(pageChunks.overview),
  },
  {
    id: "accounts",
    title: () => t("app.nav.accounts"),
    icon: icons.accounts,
    views: [
      { id: "accounts", title: () => t("app.nav.accounts"), icon: icons.accounts },
      { id: "providers", title: () => t("app.nav.providers"), icon: icons.providerKeys },
    ],
    ...page(pageChunks.accounts),
  },
  {
    id: "clients",
    title: () => t("app.nav.clients"),
    navTitle: () => t("keys.page.title"),
    icon: icons.clientKeys,
    ...page(pageChunks.clients),
  },
  {
    id: "models",
    title: () => t("app.nav.models"),
    icon: icons.models,
    views: [
      { id: "models", title: () => t("app.nav.models"), icon: icons.models },
      { id: "payload", title: () => t("app.nav.payload"), icon: icons.payload },
    ],
    ...page(pageChunks.models),
  },
  {
    id: "activity",
    title: () => t("app.nav.activity"),
    icon: icons.activity,
    views: [
      { id: "usage", title: () => t("app.nav.usage"), icon: icons.traffic },
      { id: "logs", title: () => t("app.nav.logs"), icon: icons.logs },
    ],
    ...page(pageChunks.activity),
  },
  {
    id: "settings",
    title: () => t("app.nav.settings"),
    navTitle: () => t("app.nav.config"),
    icon: icons.settings,
    ...page(pageChunks.settings),
  },
];

/** One side-nav item: a route, or one of its views. */
export type NavRef = { route: string; view?: string };

/**
 * The side nav, as the nbcards console draws it: a small heading per section over its items,
 * never collapsed. Owner, 2026-11-09: Monitor first with Overview in it, and Logs under Server.
 */
export const navSections: readonly { id: string; title(): string; items: readonly NavRef[] }[] = [
  {
    id: "monitor",
    title: () => t("app.nav.activity"),
    items: [{ route: "overview" }, { route: "activity", view: "usage" }],
  },
  {
    id: "accounts",
    title: () => t("app.nav.accounts"),
    items: [
      { route: "accounts", view: "accounts" },
      { route: "accounts", view: "providers" },
    ],
  },
  {
    id: "models",
    title: () => t("app.nav.models"),
    items: [
      { route: "models", view: "models" },
      { route: "models", view: "payload" },
    ],
  },
  {
    id: "server",
    title: () => t("app.nav.settings"),
    items: [{ route: "settings" }, { route: "clients" }, { route: "activity", view: "logs" }],
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
