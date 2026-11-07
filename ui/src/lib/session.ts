import {
  ApiError,
  ConnectionError,
  connect,
  disconnect,
  probe,
  type SessionHooks,
} from "./api/client.ts";
import { readConfig } from "./api/config.ts";
import { accountProbes, connectProbes, usageProbes } from "./api/probes.ts";
import { t } from "./i18n.ts";

/** Sign-in failed; `message` says what to do about it. */
export class SignInError extends Error {}

/**
 * Open a session with `secret`: the key is checked by reading the config, kept in memory only,
 * and every capability probe goes out once. On failure the key is dropped again.
 */
export async function openSession(secret: string, hooks: SessionHooks) {
  connect(secret, hooks);
  try {
    await readConfig();
  } catch (e) {
    disconnect();
    throw new SignInError(signInHelp(e));
  }
  probe([...accountProbes, ...connectProbes, ...usageProbes]);
}

export const closeSession = disconnect;

/** What to do about a failed sign-in, for each answer cliproxy-rs and Go give. */
function signInHelp(e: unknown): string {
  if (e instanceof ConnectionError)
    return e.reason === "timeout" ? t("app.connection.timeout") : t("app.connection.unreachable");
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  const m = e.message;
  if (e.status === 404 || /key not set/.test(m)) return t("app.signIn.apiOff");
  if (/remote management disabled/.test(m)) return t("app.signIn.remoteDisabled");
  if (/banned/i.test(m)) return t("app.signIn.banned", { message: m });
  if (e.status === 401) return t("app.signIn.wrongKey");
  return m;
}
