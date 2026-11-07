import type { Config } from "../../lib/api/config.ts";
import type { ApiKeyUsage } from "../../lib/api/observability.ts";
import type { Buckets } from "../../lib/credentials.ts";

export const families = [
  "claude",
  "codex",
  "gemini",
  "vertex",
  "openai-compatibility",
  "interactions",
  "xai",
  "meta",
] as const;
export type Family = (typeof families)[number];

export const isFamily = (value: unknown): value is Family => families.includes(value as Family);

export type Model = { name?: string; alias?: string };
export type Key = { "api-key"?: string; weight?: number };
/** A group as config.yaml holds it; fields this page does not edit travel through writes unchanged. */
export type Group = {
  name?: string;
  "base-url"?: string;
  disabled?: boolean;
  keys?: Key[];
  models?: Model[];
  [field: string]: unknown;
};

/**
 * One family's value exactly as the server holds it, for the compare in `replaceConfigValue`:
 * `null` stays `null`, and a family the file lacks reads as the empty list, which is what the
 * server's 404 fallback reads as.
 */
export function storedGroups(config: Config, family: Family): unknown {
  const section = config["api-keys"] as Record<string, unknown> | null | undefined;
  return section && family in section ? section[family] : [];
}

export const groupsOf = (stored: unknown): Group[] =>
  Array.isArray(stored) ? (stored as Group[]) : [];

/**
 * Display names, unique within the family: a group without a name reads "Group N", and a name an
 * earlier group already has gets its position appended (and more of them if that is taken too).
 * Labels only: the table and its actions address a group by its index.
 */
export function groupNames(groups: Group[], unnamed: (n: number) => string): string[] {
  const used = new Set<string>();
  return groups.map((g, i) => {
    const base = g.name?.trim() || unnamed(i + 1);
    let name = base;
    for (let n = i + 1; used.has(name); n += 1) name = `${base} #${n}`;
    used.add(name);
    return name;
  });
}

/** `name → alias` for a renamed model, the bare name otherwise. */
export const modelText = (m: Model) =>
  m.alias && m.alias !== m.name ? `${m.name} → ${m.alias}` : String(m.name ?? "");

/**
 * The usage report is keyed by family (by lower-cased group name for OpenAI-compatible groups),
 * then by "<base-url>|<api-key>". Null when the server reported nothing for this key.
 */
export function keyTraffic(
  usage: ApiKeyUsage | undefined,
  family: Family,
  group: Group,
  key: Key,
): Buckets | null {
  const provider =
    family === "openai-compatibility" ? String(group.name ?? "").toLowerCase() : family;
  const hit = usage?.[provider]?.[`${group["base-url"] ?? ""}|${key["api-key"]}`];
  if (!hit || !Array.isArray(hit.recent_requests)) return null;
  return {
    total: hit.recent_requests.map((b) => (b.success || 0) + (b.failed || 0)),
    failed: hit.recent_requests.map((b) => b.failed || 0),
  };
}

/** The busiest bucket of the family, so strips side by side compare. */
export function busiest(usage: ApiKeyUsage | undefined, family: Family, groups: Group[]): number {
  let max = 1;
  for (const g of groups)
    for (const k of g.keys ?? [])
      max = Math.max(max, ...(keyTraffic(usage, family, g, k)?.total ?? []));
  return max;
}

/** The group the Add dialog stores; the base URL is left out when empty (the provider's default). */
export function newGroup(name: string, baseUrl: string, apiKey: string): Group {
  return { name, ...(baseUrl ? { "base-url": baseUrl } : {}), keys: [{ "api-key": apiKey }] };
}

/** A usable http(s) address with a host. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host !== "";
  } catch {
    return false;
  }
}

export type FormErrors = { name?: true; baseUrl?: "required" | "invalid"; key?: true };

/** What is wrong with the trimmed add-group fields; an OpenAI-compatible group must name its endpoint. */
export function formErrors(
  fields: { name: string; baseUrl: string; key: string },
  compat: boolean,
): FormErrors {
  const errors: FormErrors = {};
  if (!fields.name) errors.name = true;
  if (!fields.baseUrl) {
    if (compat) errors.baseUrl = "required";
  } else if (!isHttpUrl(fields.baseUrl)) errors.baseUrl = "invalid";
  if (!fields.key) errors.key = true;
  return errors;
}
