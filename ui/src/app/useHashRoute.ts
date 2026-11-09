// The hash is the app's location: the page, its argument (the open row) and its query (tab,
// filter, search), so reload and Back keep them. One listener for the whole app, so the unsaved
// guard decides once per change, whoever reads the route.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { redirect } from "../lib/hash.ts";
import { parseHash } from "./routes.ts";

type Parsed = ReturnType<typeof parseHash>;
type Place = { route: Parsed["route"]; arg: string };
type Params = Readonly<Record<string, string>>;

const here = (to: string) => `${location.pathname}${location.search}${to}`;

/** An old hash is replaced by its new place in the same history entry. */
function land(before: string) {
  const to = redirect(location.hash, before);
  if (to) history.replaceState(history.state, "", here(to));
}

land("");
let hash = location.hash;
let parsed = parseHash(hash);
// Replaced only when they change, so a reader of one is not rerendered by the other.
let place: Place = { route: parsed.route, arg: parsed.arg };
let params: Params = parsed.params;
let query = new URLSearchParams(params).toString();
/** What a held-back change would do, while the discard question is open. */
let blocked: (() => void) | null = null;
/** The dirty forms, each with the query key that holds it open, if any. */
const dirty = new Map<symbol, string | undefined>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

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
  land(hash);
  if (location.hash === hash) return;
  const next = parseHash(location.hash);
  const moves = next.route !== place.route || next.arg !== place.arg;
  // A form held open by a query key (an editor at `?key=`) is left when that key changes too.
  const leaves =
    moves ||
    [...dirty.values()].some((key) => key && (next.params[key] ?? "") !== (params[key] ?? ""));
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
  if (moves) place = { route: next.route, arg: next.arg };
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

/**
 * Under this provider, `useHashRoute().arg` is the named query key instead of the path argument: a
 * page hosted in a dialog over another page keeps its open item there, so the two do not share one
 * argument (the plugins dialog over Configuration).
 */
export const ArgFromQuery = createContext<string | null>(null);

/** The current page and its argument. An unknown hash opens the first page. */
export function useHashRoute() {
  const current = useSyncExternalStore(subscribe, () => place);
  const key = useContext(ArgFromQuery);
  const scoped = useSyncExternalStore(subscribe, () => (key ? (params[key] ?? "") : null));
  return useMemo(
    () => (scoped === null ? current : { route: current.route, arg: scoped }),
    [current, scoped],
  );
}

/**
 * How a query change enters history: `push` for a choice the operator would go Back from (a tab,
 * a family, an open store), `replace` for typing and filters, so a search does not add a Back
 * step per key.
 */
type HashMode = "push" | "replace";

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
 * not asked about, except of `hashKey`, the query key that holds the form open (Back from an
 * editor at `?key=`). The returned `release` stops asking at once, for the form's own close,
 * which runs before its clean state renders.
 */
export function useUnsavedChanges(isDirty: boolean, hashKey?: string) {
  const held = useRef<symbol | null>(null);
  useEffect(() => {
    if (!isDirty) return;
    const id = Symbol("unsaved");
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    held.current = id;
    dirty.set(id, hashKey);
    addEventListener("beforeunload", ask);
    return () => {
      held.current = null;
      dirty.delete(id);
      removeEventListener("beforeunload", ask);
    };
  }, [isDirty, hashKey]);
  return useCallback(() => {
    if (held.current) dirty.delete(held.current);
  }, []);
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
