// The pure parts of a provider sign-in: which providers there are, whether a sign-in link may be
// opened, and which account a finished sign-in added.
import type { Credential } from "../../lib/api/credentials.ts";
import { label, provider } from "../../lib/credentials.ts";
import type { Status } from "../../themes/site/index.ts";

export const builtIn = [
  "claude",
  "codex",
  "antigravity",
  "kimi",
  "kimi-ai",
  "xai",
  "devin",
  "meta",
];
// The server catches these providers' redirects on its local callback port when asked.
const forwarded = new Set(["claude", "codex", "antigravity", "xai", "devin"]);
export const isForwarded = (p: string) => forwarded.has(p);

export type Phase = "wait" | "verifying" | "ok" | "refused" | "error" | "unknown" | "cancelled";

export const phaseStatus = {
  wait: "cooling",
  verifying: "cooling",
  ok: "ready",
  refused: "failing",
  error: "failing",
  unknown: "disabled",
  cancelled: "disabled",
} as const satisfies Record<Phase, Status>;

/** Whose page the operator approves on. */
export const owner = (p: string) => (p === "codex" ? "OpenAI" : label(p));

/**
 * The sign-in link as an absolute URL, resolved against the page so a relative link keeps the
 * dashboard's path prefix; null for any scheme but http and https.
 */
export function signInUrl(raw: string, page: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, page);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

/** A pasted callback address: an absolute http or https URL, never javascript:, file: or mailto:. */
export const isWebAddress = (value: string) =>
  URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol);

/** Credentials by name, as they were before the sign-in started. */
export type Seen = Map<string, Credential>;

// Only built-in providers are matched.
const mine = (p: string, seen: Seen | null, now: Credential[] | null) =>
  seen && now && builtIn.includes(p) ? now.filter((c) => provider(c) === p) : [];

/**
 * The account a sign-in the server no longer remembers added: exactly one new name of this
 * built-in provider. Anything else is unknown, since a rewritten file can be a refresh or upload.
 */
export function forgottenAccount(p: string, seen: Seen | null, now: Credential[] | null) {
  const fresh = mine(p, seen, now).filter((c) => !seen!.has(c.name));
  return fresh.length === 1 ? fresh[0] : null;
}

/** After a confirmed sign-in: the one new account of this provider, else the one rewritten. */
export function signedInAccount(p: string, seen: Seen | null, now: Credential[] | null) {
  const list = mine(p, seen, now);
  const fresh = list.filter((c) => !seen!.has(c.name));
  if (fresh.length) return fresh.length === 1 ? fresh[0] : null;
  const changed = list.filter((c) => seen!.get(c.name)?.updated_at !== c.updated_at);
  return changed.length === 1 ? changed[0] : null;
}
