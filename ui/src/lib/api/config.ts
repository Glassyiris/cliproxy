import { absent, configPath, storedValue } from "../configPath.ts";
import { ApiError, request } from "./client.ts";
import { routes } from "./routes.ts";

/** The effective config tree, including stable `@id` fields on providers and routers. */
export type Config = { "config-version"?: number; [section: string]: unknown };
export type ConfigChange = { path: string; before: unknown; next: unknown; unset?: unknown };
export type ConfigOperation =
  | { op: "set"; path: string; value: unknown; expect: unknown }
  | { op: "unset"; path: string; expect: unknown };
export type ConfigApplyResult = {
  revision: number;
  written: boolean;
  changes: unknown[];
  restart_required: boolean;
};

export const readConfig = (signal?: AbortSignal) => request<Config>(routes.readConfig, { signal });

/** One effective value. Only a missing key uses `fallback`; a stored `null` stays `null`. */
export async function readConfigValue<T = unknown>(
  path: string,
  options: { signal?: AbortSignal; fallback?: T } = {},
): Promise<T> {
  configPath(path);
  const value = storedValue(await readConfig(options.signal), path);
  if (value !== absent) return value as T;
  if ("fallback" in options) return options.fallback as T;
  throw new ApiError(`Config value ${path} not found`, 404, "not_found", routes.readConfig);
}

/** Nothing was written: a value on the server is no longer the one the page showed. */
export class ConfigChangedError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Config value ${path} changed on the server`);
    this.path = path;
  }
}

/**
 * Apply every change atomically against its shown baseline. `absent` as `next` removes a key;
 * as `before` it expects the absent default (`unset`, or null). The server also treats absent
 * values as equal to null, [] and {}. Keep stable `@id` fields in list values.
 */
export async function replaceConfigValues(
  changes: readonly ConfigChange[],
): Promise<ConfigApplyResult> {
  const ops = changes.map(({ path, before, next, unset = null }): ConfigOperation => {
    const expect =
      before === absent || before === undefined ? (unset === absent ? null : unset) : before;
    const field = configPath(path);
    return next === absent
      ? { op: "unset", path: field, expect }
      : { op: "set", path: field, value: next, expect };
  });
  return applyOperations(ops, changes.map(({ path }) => path).join(", "));
}

export function replaceConfigValue(path: string, before: unknown, next: unknown, unset?: unknown) {
  return replaceConfigValues([{ path, before, next, unset }]);
}

export type ExportResource = {
  kind: string;
  id: string;
  ord: number;
  spec: unknown;
};
export type ConfigResource = ExportResource & { rev: number };

export const readResource = (kind: string, id: string, signal?: AbortSignal) =>
  request<ConfigResource>(routes.readResource, { params: { kind, id }, signal });

export function applyResourceOperations(
  ops: { kind: string; id: string; [field: string]: unknown }[],
) {
  return applyOperations(ops, ops.map(({ kind, id }) => `${kind}/${id}`).join(", "));
}

async function applyOperations(ops: unknown[], path: string): Promise<ConfigApplyResult> {
  try {
    return await request<ConfigApplyResult>(routes.applyConfig, { body: { ops } });
  } catch (error) {
    if (error instanceof ApiError && error.status === 412) throw new ConfigChangedError(path);
    throw error;
  }
}

export const replaceResource = (resource: ConfigResource, spec: unknown) =>
  applyResourceOperations([
    { op: "put", kind: resource.kind, id: resource.id, spec, if_rev: resource.rev },
  ]);

export const patchResource = (resource: ConfigResource, patch: unknown) =>
  applyResourceOperations([
    { op: "patch", kind: resource.kind, id: resource.id, patch, if_rev: resource.rev },
  ]);

/** Only call in response to an explicit reveal/use action; never cache the plaintext export. */
export async function revealResource(kind: string, id: string): Promise<ExportResource> {
  const exported = await request<{ resources: ExportResource[] }>(routes.exportConfig, {
    query: { include_secrets: "true" },
  });
  const resource = exported.resources.find((entry) => entry.kind === kind && entry.id === id);
  if (!resource) throw new ConfigChangedError(`${kind}/${id}`);
  return resource;
}

export const isUsableSecret = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value !== "$secret";

/** Resolve both persisted identities, never a redacted value or a list position. */
export async function revealProviderKey(providerId: string, keyId: string): Promise<string> {
  const resource = await revealResource("provider", providerId);
  const spec = resource.spec;
  const keys = spec && typeof spec === "object" && "keys" in spec ? spec.keys : undefined;
  const entries: unknown[] = Array.isArray(keys) ? keys : [];
  const entry = entries.find(
    (item) => item && typeof item === "object" && "@id" in item && item["@id"] === keyId,
  );
  const key: unknown =
    entry && typeof entry === "object" && "api-key" in entry ? entry["api-key"] : undefined;
  if (!isUsableSecret(key)) throw new ConfigChangedError(`provider/${providerId}/${keyId}`);
  return key;
}
