import type { Config } from "../../lib/api/config.ts";

/** The sections the server writes, shown even before the file sets them. */
const knownSections = [
  "server",
  "management",
  "access",
  "routing",
  "requests",
  "api-keys",
  "oauth",
  "client",
  "multimedia",
  "observability",
  "plugins",
] as const;
export type KnownSection = (typeof knownSections)[number];

export const isKnown = (name: string): name is KnownSection =>
  (knownSections as readonly string[]).includes(name);

/** Every known section, then any other top-level key of the file; `config-version` is not one. */
export const sectionNames = (config: Config) =>
  [...new Set([...knownSections, ...Object.keys(config)])].filter(
    (name) => name !== "config-version",
  );

export type Summary =
  { kind: "default" } | { kind: "count"; count: number } | { kind: "value"; text: string };

export function summarize(value: unknown): Summary {
  if (value === undefined) return { kind: "default" };
  if (value && typeof value === "object")
    return { kind: "count", count: Object.keys(value).length };
  return { kind: "value", text: typeof value === "string" ? value : JSON.stringify(value) };
}
