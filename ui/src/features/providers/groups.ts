import type { Config } from "../../lib/api/config.ts";
import type { ApiKeyUsage } from "../../lib/api/observability.ts";
import type { Buckets } from "../../lib/credentials.ts";
import { families, type Family } from "../../components/keyFamilies.ts";

export type Model = { name?: string; alias?: string };
export type Key = {
  "@id"?: string;
  auth_index?: string;
  "api-key"?: string;
  weight?: number;
  [field: string]: unknown;
};
/** Stored provider fields this page does not edit travel through writes unchanged. */
export type Group = {
  "@id"?: string;
  name?: string;
  "base-url"?: string;
  disabled?: boolean;
  keys?: Key[];
  models?: Model[];
  [field: string]: unknown;
};

/**
 * One family's effective value for the write precondition: `null` stays `null`, and an absent
 * family reads as the empty list.
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

/** One key's requests per ten-minute bucket, with each bucket's span as the server writes it. */
export type KeyTraffic = Buckets & { times: string[] };

/**
 * The usage report is keyed by family (by lower-cased group name for OpenAI-compatible groups),
 * then by auth_index. Null when the server reported nothing for this key.
 */
export function keyTraffic(
  usage: ApiKeyUsage | undefined,
  family: Family,
  group: Group,
  key: Key,
): KeyTraffic | null {
  const provider =
    family === "openai-compatibility" ? String(group.name ?? "").toLowerCase() : family;
  const hit = key.auth_index ? usage?.[provider]?.[key.auth_index] : undefined;
  if (!hit || !Array.isArray(hit.recent_requests)) return null;
  return {
    total: hit.recent_requests.map((b) => (b.success || 0) + (b.failed || 0)),
    failed: hit.recent_requests.map((b) => b.failed || 0),
    times: hit.recent_requests.map((b) => b.time),
  };
}

/** A group as the table shows it: where it is stored, its display name, its keys' traffic. */
export type Entry = {
  family: Family;
  index: number;
  group: Group;
  name: string;
  keys: { key: Key; traffic: KeyTraffic | null }[];
  /** Every key's traffic added up; null when no key has any reported. */
  traffic: KeyTraffic | null;
};

export function entryId(e: Pick<Entry, "family" | "group">): string {
  const id = e.group["@id"];
  if (!id) throw new Error("Provider group has no persisted identity");
  return `${e.family}:${id}`;
}

/** Every key's buckets added up, with the first reported key's bucket spans. */
function addUp(list: (KeyTraffic | null)[]): KeyTraffic | null {
  const known = list.filter((k): k is KeyTraffic => !!k);
  if (!known.length) return null;
  const n = Math.max(...known.map((k) => k.total.length));
  const add = (field: "total" | "failed") =>
    Array.from({ length: n }, (_, i) => known.reduce((s, k) => s + (k[field][i] ?? 0), 0));
  return { total: add("total"), failed: add("failed"), times: known[0].times };
}

/** Each family's groups as entries, in `families` order; a family with no group is left out. */
export function entriesOf(
  config: Config,
  usage: ApiKeyUsage | undefined,
  unnamed: (n: number) => string,
): [Family, Entry[]][] {
  return families.flatMap((family): [Family, Entry[]][] => {
    const groups = groupsOf(storedGroups(config, family));
    if (!groups.length) return [];
    const names = groupNames(groups, unnamed);
    const entries = groups.map((group, index) => {
      const keys = (group.keys ?? []).map((key) => ({
        key,
        traffic: keyTraffic(usage, family, group, key),
      }));
      return {
        family,
        index,
        group,
        name: names[index],
        keys,
        traffic: addUp(keys.map((k) => k.traffic)),
      };
    });
    return [[family, entries]];
  });
}

/** A key failing in the window: at least half of its requests failed. */
export const isFailing = (traffic: Buckets | null) => {
  if (!traffic) return false;
  const failed = traffic.failed.reduce((a, b) => a + b, 0);
  const total = traffic.total.reduce((a, b) => a + b, 0);
  return failed > 0 && failed * 2 >= total;
};

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
  if (!fields.key || fields.key === "$secret") errors.key = true;
  return errors;
}
