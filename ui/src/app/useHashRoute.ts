// The hash is the app's location: the page, its argument (the open row) and its query (tab,
// filter, search), so reload and Back keep them. One listener for the whole app, so the unsaved
// guard decides once per change, whoever reads the route.
import { useEffect, useSyncExternalStore } from "react";
import { parseHash } from "./routes.ts";

type Parsed = ReturnType<typeof parseHash>;
type Place = { route: Parsed["route"]; arg: string };
type Params = Readonly<Record<string, string>>;

let hash = location.hash;
let parsed = parseHash(hash);
// Replaced only when they change, so a reader of one is not rerendered by the other.
let place: Place = { route: parsed.route, arg: parsed.arg };
let params: Params = parsed.params;
let query = new URLSearchParams(params).toString();
/** What a held-back change would do, while the discard question is open. */
let blocked: (() => void) | null = null;
const dirty = new Set<symbol>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const here = (to: string) => `${location.pathname}${location.search}${to}`;

// Every history entry this app passes through carries its position, so a hashchange onto an
// entry with one is Back or Forward and one without is a new navigation (a link, a typed hash).
// An entry made while nothing listened (signed out) has none and counts as new.
type Entry = { index: number };
const indexOf = (state: unknown) =>
  typeof (state as Entry | null)?.index === "number" ? (state as Entry).index : null;
let index = indexOf(history.state) ?? 0;
const mark = (at: number) => history.replaceState({ ...history.state, index: at }, "");
mark(index);

function sync() {
  if (location.hash === hash) return;
  const next = parseHash(location.hash);
  const leaves = next.route !== place.route || next.arg !== place.arg;
  const landed = indexOf(history.state);
  if (leaves && dirty.size) {
    if (landed === null) {
      // A new navigation: the browser already added its entry and cut Forward; that entry
      // shows this page again, and Discard navigates anew.
      const target = location.hash;
      history.replaceState({ ...history.state, index: index + 1 }, "", here(hash));
      index += 1;
      blocked = () => {
        location.hash = target;
      };
    } else {
      // Back or Forward: step back onto the entry the user left, which leaves every entry as it
      // was; Discard then makes the same traversal again. The step's own hashchange lands on
      // this hash and is ignored above.
      const delta = landed - index;
      history.go(-delta);
      blocked = () => history.go(delta);
    }
    emit();
    return;
  }
  if (landed === null) mark(index + 1);
  index = indexOf(history.state) ?? index;
  hash = location.hash;
  parsed = next;
  if (leaves) place = { route: next.route, arg: next.arg };
  const nextQuery = new URLSearchParams(next.params).toString();
  if (nextQuery !== query) [params, query] = [next.params, nextQuery];
  emit();
}

function subscribe(listener: () => void) {
  if (!listeners.size) {
    addEventListener("hashchange", sync);
    // The hash may have changed while nothing listened (before sign-in).
    sync();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) removeEventListener("hashchange", sync);
  };
}

/** The current page and its argument. An unknown hash opens the first page. */
export function useHashRoute() {
  return useSyncExternalStore(subscribe, () => place);
}

/**
 * How a query change enters history: `push` for a choice the operator would go Back from (a tab,
 * a family, an open store), `replace` for typing and filters, so a search does not add a Back
 * step per key.
 */
export type HashMode = "push" | "replace";

/**
 * The query after the route (`#accounts?provider=codex`) and a setter that merges changes into
 * it; an empty or undefined value removes the key.
 */
export function useHashParams() {
  const current = useSyncExternalStore(subscribe, () => params);
  const set = (changes: Record<string, string | undefined>, mode: HashMode) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes))
      if (value) next.set(key, value);
      else next.delete(key);
    const search = next.toString();
    const to = `#${parsed.path || place.route.id}${search ? `?${search}` : ""}`;
    if (to === location.hash) return;
    // A pushed entry carries its position, so sync() counts it as this app's own step.
    if (mode === "push") history.pushState({ ...history.state, index: index + 1 }, "", here(to));
    else history.replaceState(history.state, "", here(to));
    sync();
  };
  return [current, set] as const;
}

/**
 * While `isDirty`, leaving the page or the open row asks first, and so do signing out
 * (`leaveOrAsk`) and closing the tab. A change of the query alone keeps the form mounted and is
 * not asked about.
 */
export function useUnsavedChanges(isDirty: boolean) {
  useEffect(() => {
    if (!isDirty) return;
    const id = Symbol("unsaved");
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    dirty.add(id);
    addEventListener("beforeunload", ask);
    return () => {
      dirty.delete(id);
      removeEventListener("beforeunload", ask);
    };
  }, [isDirty]);
}

/**
 * Run `leave` now, or, while a form is dirty, after the user chose Discard in the shell's
 * question: for leaving that is not a hash change, such as signing out.
 */
export function leaveOrAsk(leave: () => void) {
  if (!dirty.size) return leave();
  blocked = leave;
  emit();
}

/** The navigation the unsaved guard held back, for the shell's discard question. */
export function useBlockedNavigation() {
  const resume = useSyncExternalStore(subscribe, () => blocked);
  return {
    isBlocked: resume !== null,
    stay: () => {
      blocked = null;
      emit();
    },
    discard: () => {
      blocked = null;
      dirty.clear();
      emit();
      resume?.();
    },
  };
}
