// The provider families the server's `api-keys` stores key groups under, shared by the Provider
// keys tab and the Connect dialog's API key step.
import { label } from "../lib/credentials.ts";
import { t } from "../lib/i18n.ts";

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

export const familyName = (family: Family) =>
  family === "openai-compatibility" ? t("providers.family.openaiCompatibility") : label(family);
