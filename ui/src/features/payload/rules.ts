import type { Config } from "../../lib/api/config.ts";

export const kinds = ["default", "default-raw", "override", "override-raw", "filter"] as const;
export type Kind = (typeof kinds)[number];

export const protocols = ["openai", "claude", "gemini", "codex", "antigravity"] as const;

/** One rule as the server keeps it. Hand-edited config can hold anything, so nothing is assumed. */
export type Rule = Record<string, unknown>;

/** `notList`: the server holds something other than a list for this kind. */
export type Group = { kind: Kind; entries: unknown[]; notList: boolean };

export const isRule = (entry: unknown): entry is Rule =>
  typeof entry === "object" && entry !== null && !Array.isArray(entry);

/**
 * What the server holds for `kind`: a kind the file lacks reads as the empty list, which is what
 * the server's 404 fallback reads as, and `null` stays `null`.
 */
export function storedRules(config: Config, kind: Kind): unknown {
  const requests = config.requests as Record<string, unknown> | null | undefined;
  const payload = requests?.payload as Record<string, unknown> | null | undefined;
  return payload && kind in payload ? payload[kind] : [];
}

/** The entries in place, whatever they are, so an index here is an index in the stored list. */
export const rulesOf = (stored: unknown): unknown[] => (Array.isArray(stored) ? stored : []);

/** `null` is an empty key and loses nothing when written; any other non-list is the operator's own. */
export const isList = (stored: unknown) => stored == null || Array.isArray(stored);

const text = (value: unknown) =>
  typeof value === "string" ? value : value == null ? "" : (JSON.stringify(value) ?? "");

export type RuleModel = { name: string; protocol?: string };

/** A rule's models; an entry that is not an object shows as its JSON. */
export function modelsOf(rule: Rule): RuleModel[] {
  const models = Array.isArray(rule.models) ? (rule.models as unknown[]) : [];
  return models.map((model) => {
    if (!isRule(model)) return { name: JSON.stringify(model) ?? "" };
    return model.protocol
      ? { name: text(model.name), protocol: text(model.protocol) }
      : { name: text(model.name) };
  });
}

/** What a rule sets or removes: the paths of its object, or the entries of a filter's list. */
export function fieldCount(params: unknown) {
  if (Array.isArray(params)) return params.length;
  return params && typeof params === "object" ? Object.keys(params).length : 0;
}

/** One stored entry as a row under one of its models. */
export type RuleRow = {
  /** `<kind>:<index>`: the entry's place in the stored lists. */
  key: string;
  kind: Kind;
  index: number;
  entry: unknown;
  rule: Rule | null;
  model: RuleModel | null;
};

export const NO_MODEL = "\u0000none";
export const UNREADABLE = "\u0000unreadable";

/**
 * The rules grouped by model name, in the order the names first appear; a rule that names two
 * models shows under both. Entries with no model and unreadable entries get a group of their own,
 * keyed by `NO_MODEL` and `UNREADABLE`.
 */
export function groupByModel(lists: { kind: Kind; entries: unknown[] }[]) {
  const groups = new Map<string, RuleRow[]>();
  const add = (name: string, row: RuleRow) => groups.set(name, [...(groups.get(name) ?? []), row]);
  for (const { kind, entries } of lists)
    entries.forEach((entry, index) => {
      const rule = isRule(entry) ? entry : null;
      const base = { key: `${kind}:${index}`, kind, index, entry, rule };
      if (!rule) return add(UNREADABLE, { ...base, model: null });
      const models = modelsOf(rule);
      if (!models.length) add(NO_MODEL, { ...base, model: null });
      for (const model of models) add(model.name, { ...base, model });
    });
  return [...groups].map(([name, rows]) => ({ name, rows }));
}

export type ParamsError = "invalid" | "notList" | "notObject";
type ParsedParams = { value: unknown } | { error: ParamsError };

/** A filter lists the paths to remove; every other kind maps a path to its value. */
export function parseParams(kind: Kind, text: string): ParsedParams {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "invalid" };
  }
  if (kind === "filter") return Array.isArray(value) ? { value } : { error: "notList" };
  return value && typeof value === "object" && !Array.isArray(value)
    ? { value }
    : { error: "notObject" };
}
