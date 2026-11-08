import type { Route } from "./routes.ts";

// Requests read the management key from this module's memory; lib/keyStore.ts keeps the stored
// copy that a reload reads back once.
// Requests go only to the server that served this page: the API sits next to it
// (/management.html -> /v8/management, also under a reverse-proxy path prefix).
export const base = new URL(".", location.href).href.replace(/\/$/, "");
const endpoint = `${base}/v8/management`;

export type SessionHooks = {
  /** The server rejected the key (401). */
  unauthorized(): void;
  /** Build headers of the latest answer, or null when the server could not be reached. */
  server(build: ServerBuild | null): void;
};

/** X-CPA-VERSION, X-CPA-COMMIT and X-CPA-BUILD-DATE; empty when the header is absent. */
export type ServerBuild = { version: string; commit: string; built: string };

let key = "";
// Bumped on every sign-in and sign-out, so an answer that belongs to the old session is dropped.
let revision = 0;
let hooks: SessionHooks = { unauthorized() {}, server() {} };

export function connect(secret: string, sessionHooks: SessionHooks) {
  key = secret;
  hooks = sessionHooks;
  revision++;
  resetCapabilities();
}

export function disconnect() {
  key = "";
  revision++;
  resetCapabilities();
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly method: string;
  readonly path: string;
  constructor(message: string, status: number, code: string, route: Route) {
    super(message);
    this.status = status;
    this.code = code;
    this.method = route.method;
    this.path = route.path;
  }
  /** The server does not implement this route or method: 501, 405, or Go's empty 404. */
  get notImplemented() {
    return this.status === 501 || this.status === 405 || (this.status === 404 && !this.code);
  }
}

/** No answer to show: not signed in, the session changed, the server is unreachable or too slow. */
export class ConnectionError extends Error {
  readonly reason: "signed-out" | "session-changed" | "unreachable" | "timeout";
  constructor(reason: ConnectionError["reason"]) {
    super(reason);
    this.reason = reason;
  }
}

export const notImplemented = (e: unknown) => e instanceof ApiError && e.notImplemented;

// "METHOD /pattern" of every route this server answered as not implemented, this session.
const missing = new Set<string>();
const listeners = new Set<() => void>();
const routeId = (route: Route) => `${route.method} ${route.path}`;

// Probes already sent this session, by "METHOD /pattern".
const probed = new Set<string>();

function resetCapabilities() {
  probed.clear();
  if (!missing.size) return;
  missing.clear();
  for (const listener of listeners) listener();
}

/** False once the server answered this route as not implemented. */
export const available = (route: Route) => !missing.has(routeId(route));

export function onCapabilityChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export type Call = {
  /** `{name}` segments are percent-encoded; a `{*name}` remainder is inserted as given. */
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON-encoded unless it is FormData, or text for /config.yaml. */
  body?: unknown;
  /** Aborting it drops the request, so the latest read of a value wins. */
  signal?: AbortSignal;
  as?: "json" | "text" | "blob";
  ifMatch?: string;
  onHeaders?: (headers: Headers) => void;
};

function url(route: Route, call: Call) {
  const path = route.path.replace(/\{(\*?)(\w+)\}/g, (_, rest: string, name: string) => {
    const value = call.params?.[name];
    if (value === undefined) throw new Error(`Missing path parameter ${name} for ${route.path}`);
    return rest ? value : encodeURIComponent(value);
  });
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined) query.set(k, String(v));
  const search = query.size ? `?${query}` : "";
  return { path, href: `${endpoint}${path}${search}` };
}

async function send(route: Route, call: Call) {
  if (!key) throw new ConnectionError("signed-out");
  const at = revision;
  const { path, href } = url(route, call);
  const yaml = path === "/config.yaml";
  const form = call.body instanceof FormData;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (call.body !== undefined && !form)
    headers["Content-Type"] = yaml ? "application/yaml" : "application/json";
  if (call.ifMatch) headers["If-Match"] = call.ifMatch;
  const timeout = AbortSignal.timeout(path.includes("/refresh") ? 300_000 : 30_000);
  let response: Response;
  try {
    response = await fetch(href, {
      method: route.method,
      headers,
      body:
        call.body === undefined || form || yaml
          ? (call.body as BodyInit | undefined)
          : JSON.stringify(call.body),
      signal: call.signal ? AbortSignal.any([call.signal, timeout]) : timeout,
      cache: "no-store",
      redirect: "error",
    });
  } catch (e) {
    if (call.signal?.aborted) throw e;
    if (at !== revision) throw new ConnectionError("session-changed");
    hooks.server(null);
    throw new ConnectionError(timeout.aborted ? "timeout" : "unreachable");
  }
  if (at !== revision) throw new ConnectionError("session-changed");
  const header = (name: string) => response.headers.get(name) ?? "";
  hooks.server({
    version: header("x-cpa-version"),
    commit: header("x-cpa-commit"),
    built: header("x-cpa-build-date"),
  });
  return response;
}

/** One management request. Errors are ApiError (the server answered) or ConnectionError. */
export async function request<T>(route: Route, call: Call = {}): Promise<T> {
  const at = revision;
  const response = await send(route, call);
  call.onHeaders?.(response.headers);
  const as = call.as ?? "json";
  let value;
  try {
    value = !response.ok
      ? await response.json().catch(() => ({}))
      : as === "blob"
        ? await response.blob()
        : as === "text"
          ? await response.text()
          : response.status === 204
            ? undefined
            : await response.json();
  } catch (e) {
    // A body that breaks off or is not JSON is a failed answer, the same as a failed fetch.
    if (call.signal?.aborted) throw e;
    if (at !== revision) throw new ConnectionError("session-changed");
    hooks.server(null);
    // The request's own 30 s timeout also covers reading the body.
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    throw new ConnectionError(timedOut ? "timeout" : "unreachable");
  }
  // A body that finishes after sign-out or a reconnect belongs to the old session.
  if (at !== revision) throw new ConnectionError("session-changed");
  if (response.ok) return value as T;
  if (response.status === 401) hooks.unauthorized();
  const error = new ApiError(
    String(value.message || value.error || `HTTP ${response.status}`),
    response.status,
    String(value.code || value.error || ""),
    route,
  );
  if (error.notImplemented && !missing.has(routeId(route))) {
    missing.add(routeId(route));
    for (const listener of listeners) listener();
  }
  throw error;
}

export type Probe = { route: Route; query?: Record<string, string | number> };

/**
 * Find unimplemented actions before they are offered. Each probe is a request the server rejects
 * with 400 during input validation, before any side effect: an empty JSON body, or a GET without
 * its required parameter. A server lacking the route answers an empty 404 (or 501/405), which
 * request() records, so available() turns false. Each probe goes out once per session.
 */
export function probe(list: readonly Probe[]) {
  for (const { route, query } of list) {
    if (probed.has(routeId(route))) continue;
    probed.add(routeId(route));
    request(route, { query, body: route.method === "GET" ? undefined : {} }).catch(() => {});
  }
}
