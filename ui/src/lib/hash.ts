// Hashes of pages that became a tab or a dialog (DESIGN.md "Routes"), so old links, bookmarks and
// the features' own `location.hash` writes still land. A tab is `?view=<tab>` on its route, a
// dialog `?open=<dialog>`; a dialog that belongs to no page (connect, about) opens over the page
// the operator is on.

type Legacy =
  { route: string; params?: Record<string, string>; argParam?: string } | { over: string };

const legacy: Record<string, Legacy> = {
  providers: { route: "accounts", params: { view: "providers" } },
  credentials: { route: "accounts" },
  quotas: { route: "accounts" },
  keys: { route: "clients" },
  use: { route: "clients", params: { open: "use" } },
  usage: { route: "activity" },
  logs: { route: "activity", params: { view: "logs" } },
  payload: { route: "models", params: { view: "payload" } },
  config: { route: "settings" },
  configuration: { route: "settings" },
  // The plugins dialog sits over Configuration, whose own editor is the path argument, so the
  // open plugin moves into the query.
  plugins: { route: "settings", params: { open: "plugins" }, argParam: "plugin" },
  connect: { over: "connect" },
  oauth: { over: "connect" },
  system: { over: "about" },
};

function split(hash: string) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const mark = raw.indexOf("?");
  const path = mark < 0 ? raw : raw.slice(0, mark);
  const [id = "", ...rest] = path.split("/");
  return {
    id,
    arg: rest.join("/"),
    query: new URLSearchParams(mark < 0 ? "" : raw.slice(mark + 1)),
  };
}

function join(path: string, query: URLSearchParams) {
  const search = query.toString();
  return `#${path}${search ? `?${search}` : ""}`;
}

/**
 * The hash `hash` now lives at, or null when it is current. `from` is the hash shown before it,
 * the page a dialog without a page of its own opens over (Overview when there is none).
 */
export function redirect(hash: string, from = ""): string | null {
  const { id, arg, query } = split(hash);
  const target = legacy[id];
  if (!target) return null;
  if ("over" in target) {
    const before = from && !legacy[split(from).id] ? split(from) : split("#overview");
    before.query.set("open", target.over);
    return join([before.id, before.arg].filter(Boolean).join("/"), before.query);
  }
  for (const [key, value] of Object.entries(target.params ?? {})) query.set(key, value);
  if (target.argParam) {
    if (arg) query.set(target.argParam, decodeURIComponent(arg));
    return join(target.route, query);
  }
  return join(arg ? `${target.route}/${arg}` : target.route, query);
}
