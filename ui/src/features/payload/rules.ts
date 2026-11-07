import type { Config } from "../../lib/api/config.ts";

export const kinds = ["default", "default-raw", "override", "override-raw", "filter"] as const;
export type Kind = (typeof kinds)[number];

export const protocols = ["openai", "claude", "gemini", "codex", "antigravity"] as const;

/** One rule as the server keeps it. Hand-edited config can hold anything, so nothing is assumed. */
export type Rule = Record<string, unknown>;

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

/** `name · protocol` per model; an entry that is not an object shows as its JSON. */
export function modelLabels(rule: Rule): string[] {
  const models = Array.isArray(rule.models) ? (rule.models as unknown[]) : [];
  return models.map((model) => {
    if (!isRule(model)) return JSON.stringify(model) ?? "";
    const name = text(model.name);
    return model.protocol ? `${name} · ${text(model.protocol)}` : name;
  });
}

export type ParamsError = "invalid" | "notList" | "notObject";
export type ParsedParams = { value: unknown } | { error: ParamsError };

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
