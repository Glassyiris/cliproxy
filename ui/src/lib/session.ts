import {
  ApiError,
  ConnectionError,
  connect,
  disconnect,
  probe,
  request,
  type SessionHooks,
} from "./api/client.ts";
import { accountProbes, connectProbes, usageProbes } from "./api/probes.ts";
import { routes } from "./api/routes.ts";
import { t } from "./i18n.ts";
import { forget } from "./keyStore.ts";

/** Sign-in failed; `message` says what to do about it. */
export class SignInError extends Error {}

let signOuts = 0;

/** Cancel checks already in progress, so a sign-out in any tab cannot be undone by a late answer. */
export function cancelSignIns() {
  signOuts++;
}

// The latest revocation; a sign-in in this tab waits for it, so it cannot end the new session.
// ponytail: tabs do not wait for each other's revocation. A tab already on the sign-in page that
// signs in while another tab's sign-out still awaits its last requests can lose that new session.
// Upgrade path: a Web Locks lock around sign-in and revocation, once the dashboard needs a secure
// context (locks are unavailable over plain HTTP).
let revoking: Promise<unknown> = Promise.resolve();

/**
 * Sign out: end the server session once `before` settles (the requests a sign-out still sends with
 * the cookie, cancelling a pending account sign-in, go first), then tell the other tabs. Resolves
 * once the server confirmed, or answered 401 because the session had already ended. Otherwise it
 * rejects and tells no tab: the session may still be live, so the tab stays signed in.
 */
export function revokeSession(before: Promise<unknown> = Promise.resolve()) {
  return endSession(before).then(() => forget());
}

/** End the session the cookie holds once `before` settles; a sign-in in this tab waits for it. */
function endSession(before: Promise<unknown> = Promise.resolve()) {
  const done = before
    .catch(() => undefined)
    .then(() => request(routes.signOut, { outside: {} }))
    .catch((e: unknown) => {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
    });
  revoking = done.catch(() => undefined);
  return done;
}

/**
 * Sign in with `secret`: the key goes once, in the header of the session request, and the server
 * answers with an HttpOnly cookie that every later request carries. No copy of the key is kept.
 * `remember` asks for 30 days instead of 7. Aborting `signal` gives up the check, which counts as a
 * server that could not be reached. A sign-out elsewhere during the check cancels it before probes
 * run and ends the session this sign-in opened.
 */
export async function openSession(
  secret: string,
  remember: boolean,
  hooks: SessionHooks,
  signal?: AbortSignal,
) {
  const at = signOuts;
  await revoking;
  // The cookie is scoped to the dashboard's own path, which a reverse proxy may prefix.
  const path = new URL(".", location.href).pathname;
  try {
    await request(routes.signIn, { body: { remember, path }, signal, outside: { key: secret } });
  } catch (e) {
    throw failure(e, at, signal);
  }
  try {
    await enter(at, hooks, signal, true);
  } catch (e) {
    // A sign-out elsewhere came before this sign-in finished. Its revocation may have gone out
    // before the browser stored this sign-in's cookie, and the tab cannot tell, so end that
    // session here; the other tabs already signed out.
    if (at !== signOuts) await endSession().catch(() => undefined);
    throw e;
  }
}

/** Resume the session this browser's cookie holds, on page load. Fails when there is none. */
export function resumeSession(hooks: SessionHooks, signal?: AbortSignal) {
  return enter(signOuts, hooks, signal, false);
}

/** Confirm the cookie names a live session, then start this tab's session and its probes. */
async function enter(
  at: number,
  hooks: SessionHooks,
  signal: AbortSignal | undefined,
  fresh: boolean,
) {
  try {
    await request(routes.checkSession, { signal, outside: {} });
  } catch (e) {
    // The key was just accepted, so a missing session means the browser refused the cookie.
    if (fresh && at === signOuts && e instanceof ApiError && e.status === 401)
      throw new SignInError(t("app.signIn.cookieBlocked"));
    throw failure(e, at, signal);
  }
  // The tab that signed out ended the session; this one only stops.
  if (at !== signOuts) throw new SignInError(t("app.signIn.signedOutElsewhere"));
  connect(hooks);
  probe([...accountProbes, ...connectProbes, ...usageProbes]);
}

export const closeSession = disconnect;

function failure(e: unknown, at: number, signal?: AbortSignal) {
  if (at !== signOuts) return new SignInError(t("app.signIn.signedOutElsewhere"));
  return new SignInError(signal?.aborted ? t("app.connection.unreachable") : signInHelp(e));
}

/** What to do about a failed sign-in. */
function signInHelp(e: unknown): string {
  if (e instanceof ConnectionError)
    return e.reason === "timeout" ? t("app.connection.timeout") : t("app.connection.unreachable");
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  const m = e.message;
  if (/key not set/.test(m)) return t("app.signIn.apiOff");
  if (/remote management disabled/.test(m)) return t("app.signIn.remoteDisabled");
  if (/banned/i.test(m)) return t("app.signIn.banned", { message: m });
  if (e.status === 401) return t("app.signIn.wrongKey");
  return m;
}
