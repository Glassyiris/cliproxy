// The signed-in app's chunks, kept out of the entry: the sign-in page loads none of them. A stored
// key starts the shell and the current page while it is checked, and a typed one as it is entered,
// so neither waits for the other or for the check. A chunk already in renders at once:
// React.lazy suspends once even then, and React holds a revealed Suspense boundary back for up
// to 300 ms.
import type { ComponentType } from "react";

/** A page chunk failed to load. React.lazy keeps the rejection, so only a reload fetches it again. */
export class PageLoadError extends Error {}

/** One chunk, fetched once; `loaded` is its module once it is in. */
export type Chunk<T> = { load(): Promise<T>; loaded(): T | undefined };

function chunk<T>(load: () => Promise<T>): Chunk<T> {
  let value: T | undefined;
  let pending: Promise<T> | undefined;
  return {
    load: () =>
      (pending ??= load().then(
        (module) => (value = module),
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      )),
    loaded: () => value,
  };
}

type PageModule = { default: ComponentType };

/** Each route's page chunk, by route id (routes.ts); the first is the landing page. */
export const pageChunks = {
  overview: chunk<PageModule>(() => import("../features/overview/index.ts")),
  accounts: chunk<PageModule>(() => import("./pages/AccountsPage.tsx")),
  clients: chunk<PageModule>(() => import("./pages/ClientsPage.tsx")),
  models: chunk<PageModule>(() => import("./pages/ModelsPage.tsx")),
  activity: chunk<PageModule>(() => import("./pages/ActivityPage.tsx")),
  settings: chunk<PageModule>(() => import("./pages/SettingsPage.tsx")),
};

/** The shell, the quota checker and everything they share with the pages. */
const shell = chunk(() => import("./SignedIn.tsx"));

/** The page the hash opens. */
function currentPage() {
  const id = location.hash.slice(1).split(/[/?]/)[0] ?? "";
  return id in pageChunks ? pageChunks[id as keyof typeof pageChunks] : pageChunks.overview;
}

/**
 * The shell, once it and the current page are in. A page that fails to load does not hold the
 * shell back: the shell shows and reports it.
 */
export function loadSignedIn() {
  const page = currentPage()
    .load()
    .catch(() => undefined);
  return Promise.all([shell.load(), page]).then(([module]) => module);
}

/** The shell when it and the current page are already in. */
export const loadedSignedIn = () => (currentPage().loaded() ? shell.loaded() : undefined);

/** Start fetching the shell and the current page; a failure is reported by the render needing it. */
export function preloadSignedIn() {
  loadSignedIn().catch(() => undefined);
}
