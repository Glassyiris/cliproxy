import type { Config } from "../../lib/api/config.ts";
import type { Plugin, StorePlugin } from "../../lib/api/plugins.ts";

export type PluginState = "loaded" | "restart" | "disabled";

/**
 * Loaded and effective is "loaded". An enabled plugin that is not loaded and effective needs a
 * restart (a fresh install is unregistered until then). A switched-off plugin is "disabled",
 * registered or not.
 */
export function pluginState(p: Plugin): PluginState {
  if (p.registered && p.effective_enabled) return "loaded";
  return p.enabled ? "restart" : "disabled";
}

export function capabilities(p: Plugin): ("signIn" | "quota")[] {
  return [
    ...(p.supports_oauth ? (["signIn"] as const) : []),
    ...(p.supports_quota ? (["quota"] as const) : []),
  ];
}

type Holder = { enabled?: unknown } | null | undefined;

/**
 * An `enabled` switch as the server holds it, for the compare in `replaceConfigValue`: `null`
 * stays `null`, and a key the file lacks reads as `{}`, which is what the server's 404 fallback
 * reads as. Without `id` it is the switch for plugins as a whole.
 */
export function storedEnabled(config: Config, id?: string): unknown {
  const plugins = config.plugins as
    { enabled?: unknown; configs?: Record<string, Holder> | null } | null | undefined;
  const holder: Holder = id === undefined ? plugins : plugins?.configs?.[id];
  return typeof holder === "object" && holder && "enabled" in holder ? holder.enabled : {};
}

/** Store and plugin strings arrive HTML-escaped: decode entities as text, never as markup. */
export const plainText = (value: string) =>
  new DOMParser().parseFromString(value, "text/html").body.textContent ?? "";

/** Installed plugins name themselves in their metadata; a store entry has its own `name`. */
export const pluginName = (p: Plugin | StorePlugin) =>
  plainText(("metadata" in p ? p.metadata?.name : p.name) || p.id);
