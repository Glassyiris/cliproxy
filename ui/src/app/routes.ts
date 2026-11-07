import { lazy, type ComponentType, type LazyExoticComponent, type SVGProps } from "react";
import { ServerIcon } from "../components/icons.tsx";
import { t } from "../lib/i18n.ts";

export type PageRoute = {
  /** The hash segment: `#system`. */
  id: string;
  title(): string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
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
    title: () => t("app.nav.system"),
    icon: ServerIcon,
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
