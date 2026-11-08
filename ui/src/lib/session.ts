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

/**
 * Why a sign-in failed: the server refused the key (401), could not be reached, or anything else
 * (management API off, remote management disabled, address banned).
 */
export type SignInReason = "rejected" | "unreachable" | "other";

/** Sign-in failed; `message` says what to do about it. */
export class SignInError extends Error {
  readonly reason: SignInReason;
  constructor(message: string, reason: SignInReason) {
    super(message);
    this.reason = reason;
  }
}

let signOuts = 0;

/** Cancel checks already in progress, so a sign-out in any tab cannot be undone by a late answer. */
export function cancelSignIns() {
  signOuts++;
}

/**
 * Open a session with `secret`: the key is checked by reading the config and held in the API
 * client's memory (app/Session.tsx stores it through lib/keyStore.ts), and every capability probe
 * goes out once. On failure the key is dropped from memory again. Aborting `signal` gives up the
 * check, which counts as a server that could not be reached. A sign-out during the check cancels
 * it before probes or the caller can keep the key.
 */
export async function openSession(secret: string, hooks: SessionHooks, signal?: AbortSignal) {
  const at = signOuts;
  connect(secret, hooks);
  try {
    await readConfig(signal);
  } catch (e) {
    disconnect();
    const [message, reason] = signal?.aborted
      ? [t("app.connection.unreachable"), "unreachable" as const]
      : signInHelp(e);
    throw new SignInError(message, reason);
  }
  if (at !== signOuts) {
    disconnect();
    throw new SignInError(t("app.signIn.signedOutElsewhere"), "other");
  }
  probe([...accountProbes, ...connectProbes, ...usageProbes]);
}

export const closeSession = disconnect;

/** What to do about a failed sign-in, and why it failed, for each answer cliproxy-rs and Go give. */
function signInHelp(e: unknown): [string, SignInReason] {
  if (e instanceof ConnectionError)
    return [
      e.reason === "timeout" ? t("app.connection.timeout") : t("app.connection.unreachable"),
      "unreachable",
    ];
  if (!(e instanceof ApiError)) return [e instanceof Error ? e.message : String(e), "other"];
  const m = e.message;
  if (e.status === 404 || /key not set/.test(m)) return [t("app.signIn.apiOff"), "other"];
  if (/remote management disabled/.test(m)) return [t("app.signIn.remoteDisabled"), "other"];
  if (/banned/i.test(m)) return [t("app.signIn.banned", { message: m }), "other"];
  if (e.status === 401) return [t("app.signIn.wrongKey"), "rejected"];
  return [m, "other"];
}
