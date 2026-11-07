import type { Config } from "../../lib/api/config.ts";
import type { ModelDefinition } from "../../lib/api/routing.ts";

export const channels = [
  "claude",
  "codex",
  "antigravity",
  "kimi",
  "xai",
  "meta",
  "vertex",
  "aistudio",
] as const;
export type Channel = (typeof channels)[number];
export const isChannel = (value: unknown): value is Channel => channels.includes(value as Channel);

/** `fork` keeps the upstream name available beside the alias. */
export type Alias = { name: string; alias: string; fork?: boolean };
export type Section = "model-alias" | "excluded-models";

export const configPath = (section: Section, channel: Channel) => `oauth/${section}/${channel}`;

/**
 * One channel's list as the server holds it: `stored` is what a write compares against, so a
 * stored `null` stays `null` and a key the file lacks is the empty list (the server's 404
 * fallback); `list` is what the page shows.
 */
export function readList<T>(config: Config, section: Section, channel: Channel) {
  let node: unknown = config;
  for (const key of ["oauth", section, channel])
    node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
  const stored = (node === undefined ? [] : node) as T[] | null;
  return { stored, list: stored ?? [] };
}

export type AliasProblems = { name?: "required"; alias?: "required" | "duplicate" | "same" };

/**
 * The server's `sanitize_aliases` (crates/cpa-core/src/registry/dynamic.rs) drops an alias that
 * is empty, equal to its upstream name, or already taken, all compared ignoring case, so a form
 * that accepted one would report a success the runtime ignores.
 */
export function aliasProblems(name: string, alias: string, list: Alias[]): AliasProblems {
  const lower = alias.toLowerCase();
  let problem: AliasProblems["alias"];
  if (!alias) problem = "required";
  else if (name.toLowerCase() === lower) problem = "same";
  else if (list.some((a) => a.alias.trim().toLowerCase() === lower)) problem = "duplicate";
  return { name: name ? undefined : "required", alias: problem };
}

export const newAlias = (name: string, alias: string, keep: boolean): Alias =>
  keep ? { name, alias, fork: true } : { name, alias };

/** True when the pattern is already excluded, so the write would change nothing. */
export const isExcluded = (list: string[], pattern: string) => list.includes(pattern);

export interface CatalogRow extends Record<string, unknown> {
  id: string;
  name: string;
  context: number;
  output: number;
}

/** Gemini-format definitions carry their limits as `inputTokenLimit` and `outputTokenLimit`. */
export const catalogRow = (m: ModelDefinition): CatalogRow => ({
  id: m.id,
  name: m.display_name ?? "",
  context: m.context_length ?? m.inputTokenLimit ?? 0,
  output: m.max_completion_tokens ?? m.outputTokenLimit ?? 0,
});

export function matchesQuery(row: CatalogRow, query: string) {
  const q = query.trim().toLowerCase();
  return !q || row.id.toLowerCase().includes(q) || row.name.toLowerCase().includes(q);
}

/** Thousands as `128k`; null when the definition gives no limit. */
export function kilo(n: number) {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return n > 0 ? String(n) : null;
}
