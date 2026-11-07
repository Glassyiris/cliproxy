import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { IconProps } from "@astryxdesign/core/Icon";
import { Server } from "lucide-react";
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

// The navigation lists exactly these, in this order. A page appears here once it is built.
export const routes: readonly PageRoute[] = [
  {
    id: "system",
    group: "server",
    title: () => t("app.nav.system"),
    icon: Server,
    page: page(() => import("../features/system/index.ts")),
  },
];

/** The page a hash names, and the rest of the hash; an unknown or empty hash opens the first page. */
export function parseHash(hash: string) {
  let value = hash.slice(1);
  try {
    value = decodeURIComponent(value);
  } catch {
    // A malformed escape is read as written.
  }
  const [id = "", ...rest] = value.split("/");
  return { route: routes.find((r) => r.id === id) ?? routes[0], arg: rest.join("/") };
}
