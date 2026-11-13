import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { t } from "../lib/i18n.ts";
import { notify } from "../lib/notify.ts";
import type { ServerBuild, SessionHooks } from "../lib/api/client.ts";
import { dropLegacyKey, onForgotten } from "../lib/keyStore.ts";
import {
  cancelSignIns,
  closeSession,
  openSession,
  resumeSession,
  revokeSession,
} from "../lib/session.ts";

type SessionState = {
  signedIn: boolean;
  /** True while this browser's session cookie is checked on load (at most RESTORE_LIMIT ms). */
  restoring: boolean;
  /** False once a request could not reach the server; true again on the next answer. */
  online: boolean;
} & ServerBuild;

type Session = SessionState & {
  /** Sign in with a typed key; `remember` keeps the session for 30 days instead of 7. */
  signIn: (secret: string, remember: boolean) => Promise<void>;
  /** Revoke the session, then sign out every tab; on failure say so and stay signed in. */
  signOut: () => Promise<void>;
  /**
   * Run `work` when the operator signs out, while the session is still live, so a page can end what
   * it started on the server; the session is revoked after the promise `work` returns settles. An
   * ended session signs out without it. Returns the unregister function.
   */
  beforeSignOut: (work: () => unknown) => () => void;
};

const signedOut: SessionState = {
  signedIn: false,
  restoring: false,
  online: true,
  version: "",
  commit: "",
  built: "",
};
const SessionContext = createContext<Session | null>(null);
/** How long the session cookie is checked before the sign-in form shows; a hung server counts as down. */
const RESTORE_LIMIT = 10_000;

/** The state after an answer: `build` is its headers, or null when the server was not reached. */
function withBuild(s: SessionState, build: ServerBuild | null): SessionState {
  if (build === null) return s.online ? { ...s, online: false } : s;
  // Bare answers (the server's own 404 for an unknown route) carry no build headers.
  const bare = !build.version && !build.commit && !build.built;
  const next = bare ? { version: s.version, commit: s.commit, built: s.built } : build;
  const same = s.version === next.version && s.commit === next.commit && s.built === next.built;
  return s.online && same ? s : { ...s, ...next, online: true };
}

/**
 * Resume the cookie's session once per load (the ref keeps StrictMode's second effect run out).
 * `failed` runs when there is none, or the server cannot be reached within RESTORE_LIMIT.
 */
function useRestore(resume: (signal: AbortSignal) => Promise<void>, failed: () => void) {
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    resume(AbortSignal.timeout(RESTORE_LIMIT)).catch(failed);
  }, [resume, failed]);
}

/**
 * A sign-out in another tab revoked the shared session; this tab follows without a request of its
 * own, and a sign-in it is still checking is cancelled. The signing-out tab hears its own message
 * too, after it has signed out.
 */
function useFollowSignOut(signedIn: RefObject<boolean>, endSession: () => void) {
  useEffect(
    () =>
      onForgotten(() => {
        cancelSignIns();
        if (signedIn.current) endSession();
      }),
    [signedIn, endSession],
  );
}

/**
 * Only an explicit sign-out revokes the session, after the `leaving` work settles. The other tabs
 * hear of it once the server has confirmed; until then this tab stays signed in, so a failure
 * leaves it usable for a retry.
 */
function useSignOut(leaving: ReadonlySet<() => unknown>, endSession: () => void) {
  return useCallback(async () => {
    const last = Promise.allSettled([...leaving].map((work) => Promise.resolve(work())));
    try {
      await revokeSession(last);
    } catch {
      notify("error", t("app.signOut.failed"));
      return;
    }
    endSession();
  }, [leaving, endSession]);
}

/**
 * The one session of this tab. The browser's HttpOnly session cookie, shared by every tab,
 * authenticates its requests; the key itself is sent once, at sign-in, and never kept.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState(() => ({ ...signedOut, restoring: true }));
  const signedIn = useRef(false);
  const [leaving] = useState(() => new Set<() => void>());

  /** End the session in this tab only; the caller decides whether the server session ends too. */
  const endSession = useCallback(() => {
    closeSession();
    signedIn.current = false;
    // Every cached answer belongs to the old key.
    queryClient.clear();
    setState(signedOut);
  }, [queryClient]);

  useFollowSignOut(signedIn, endSession);
  useEffect(dropLegacyKey, []);

  const signOut = useSignOut(leaving, endSession);

  const beforeSignOut = useCallback(
    (work: () => unknown) => {
      leaving.add(work);
      return () => void leaving.delete(work);
    },
    [leaving],
  );

  const hooks = useMemo<SessionHooks>(
    () => ({
      unauthorized() {
        if (!signedIn.current) return;
        // The session expired, was revoked, or the management key changed.
        endSession();
        notify("error", t("app.signIn.rejected"));
      },
      server(build) {
        setState((s) => withBuild(s, build));
      },
    }),
    [endSession],
  );

  const entered = useCallback(() => {
    signedIn.current = true;
    setState((s) => ({ ...s, signedIn: true, restoring: false }));
  }, []);

  const signIn = useCallback(
    async (secret: string, remember: boolean) => {
      await openSession(secret, remember, hooks);
      entered();
    },
    [hooks, entered],
  );

  useRestore(
    useCallback(
      async (signal: AbortSignal) => {
        await resumeSession(hooks, signal);
        entered();
      },
      [hooks, entered],
    ),
    useCallback(() => setState((s) => ({ ...s, restoring: false })), []),
  );

  const value = useMemo(
    () => ({ ...state, signIn, signOut, beforeSignOut }),
    [state, signIn, signOut, beforeSignOut],
  );
  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession() {
  const value = use(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}
