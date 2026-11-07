import { equal } from "../compare.ts";
import { fieldPath } from "../config-path.ts";
import { ApiError, request } from "./client.ts";
import { routes } from "./routes.ts";

/** The saved config as JSON. Its tree follows config.yaml; only `config-version` is fixed. */
export type Config = { "config-version"?: number; [section: string]: unknown };
export type ConfigWrite = { "config-version": number; status: "ok" };

export const readConfig = (signal?: AbortSignal) => request<Config>(routes.readConfig, { signal });

export const readConfigYaml = (signal?: AbortSignal) =>
  request<string>(routes.readConfigYaml, { signal, as: "text" });

export const writeConfigYaml = (yaml: string) =>
  request<ConfigWrite>(routes.writeConfigYaml, { body: yaml });

// `path` is a config key path such as "routing/strategy"; each segment is checked and encoded.
const params = (path: string) => ({ path: fieldPath(path).slice("/config/".length) });

/** One config value. With `fallback`, a key the file does not set reads as that value. */
export async function readConfigValue<T = unknown>(
  path: string,
  options: { signal?: AbortSignal; fallback?: T } = {},
) {
  try {
    return await request<T>(routes.readConfigValue, {
      params: params(path),
      signal: options.signal,
    });
  } catch (e) {
    if (
      "fallback" in options &&
      e instanceof ApiError &&
      e.status === 404 &&
      e.code === "not_found"
    )
      return options.fallback as T;
    throw e;
  }
}

export const writeConfigValue = (path: string, value: unknown) =>
  request<ConfigWrite>(routes.writeConfigValue, { params: params(path), body: value });

/** Nothing was written: the value on the server is no longer the one the page showed. */
export class ConfigChangedError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Config value ${path} changed on the server`);
    this.path = path;
  }
}

/**
 * Replace one config value only if the server still holds `before`. `unset` is what an absent
 * value reads as: an empty list or map unless given. Callers reread the config either way.
 */
export async function replaceConfigValue(
  path: string,
  before: unknown,
  next: unknown,
  unset: unknown = Array.isArray(before) ? [] : {},
) {
  const latest = await readConfigValue(path, { fallback: unset });
  if (!equal(latest, before)) throw new ConfigChangedError(path);
  return writeConfigValue(path, next);
}
