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

/** One channel's list as the page shows it: a stored `null` and a key the file lacks are empty. */
export function readList<T>(config: Config, section: Section, channel: Channel): T[] {
  let node: unknown = config;
  for (const key of ["oauth", section, channel])
    node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
  return (node ?? []) as T[];
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

/**
 * The server's `wildcard` (crates/cpa-core/src/registry/dynamic.rs), which it applies to the
 * lowercased pattern and model ID: `*` matches any run, the rest must match in order.
 */
export function wildcard(pattern: string, value: string) {
  if (!pattern) return false;
  if (!pattern.includes("*")) return pattern === value;
  const parts = pattern.split("*");
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!value.startsWith(first)) return false;
  let rest = value.slice(first.length);
  if (!rest.endsWith(last)) return false;
  rest = rest.slice(0, rest.length - last.length);
  for (const segment of parts.slice(1, -1)) {
    if (!segment) continue;
    const at = rest.indexOf(segment);
    if (at < 0) return false;
    rest = rest.slice(at + segment.length);
  }
  return true;
}

/** The first stored pattern that hides `id`, as the server matches it. */
function excludedBy(patterns: string[], id: string) {
  const lower = id.trim().toLowerCase();
  return patterns.find((p) => wildcard(p.trim().toLowerCase(), lower));
}

export interface ModelRow extends Record<string, unknown> {
  /** `<channel>/<id>`: one model ID can appear in two families. */
  key: string;
  channel: Channel;
  id: string;
  name: string;
  context: number;
  output: number;
  aliases: string[];
  excludedBy?: string;
}

/** One family's catalog with its aliases and exclusions. Gemini-format limits are read too. */
export function modelRows(
  channel: Channel,
  models: ModelDefinition[],
  aliases: Alias[],
  excluded: string[],
): ModelRow[] {
  return models.map((m) => ({
    key: `${channel}/${m.id}`,
    channel,
    id: m.id,
    name: m.display_name ?? "",
    context: m.context_length ?? m.inputTokenLimit ?? 0,
    output: m.max_completion_tokens ?? m.outputTokenLimit ?? 0,
    aliases: aliases
      .filter((a) => a.name.trim().toLowerCase() === m.id.toLowerCase())
      .map((a) => a.alias),
    excludedBy: excludedBy(excluded, m.id),
  }));
}

export interface RuleRow extends Record<string, unknown> {
  key: string;
  channel: Channel;
  kind: "alias" | "excluded";
  /** The position in the stored list, which the removal writes by. */
  index: number;
  /** The upstream model of an alias, or the excluded pattern. */
  pattern: string;
  alias?: string;
  fork?: boolean;
}

export function ruleRows(channel: Channel, aliases: Alias[], excluded: string[]): RuleRow[] {
  return [
    ...aliases.map((a, index) => ({
      key: `${channel}/alias/${index}`,
      channel,
      kind: "alias" as const,
      index,
      pattern: a.name,
      alias: a.alias,
      fork: a.fork,
    })),
    ...excluded.map((pattern, index) => ({
      key: `${channel}/excluded/${index}`,
      channel,
      kind: "excluded" as const,
      index,
      pattern,
    })),
  ];
}

/** Search across a row's identifiers, ignoring case and outer spaces. */
export function matchesQuery(texts: (string | undefined)[], query: string) {
  const q = query.trim().toLowerCase();
  return !q || texts.some((text) => text?.toLowerCase().includes(q));
}

/** Thousands as `128k`; null when the definition gives no limit. */
export function kilo(n: number) {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return n > 0 ? String(n) : null;
}

/** DESIGN.md "Pages": a long list pages at 20 rows. */
export const PAGE_SIZE = 20;

/** The rows of a 1-based page, the page clamped to the ones that exist. */
export function pageOf<T>(rows: T[], page: number) {
  const last = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const at = Math.min(Math.max(1, Math.trunc(page) || 1), last);
  return { page: at, rows: rows.slice((at - 1) * PAGE_SIZE, at * PAGE_SIZE) };
}
