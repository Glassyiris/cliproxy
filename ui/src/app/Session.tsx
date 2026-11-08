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
import { discard, forget, onForgotten, recall, remember } from "../lib/keyStore.ts";
import { cancelSignIns, closeSession, openSession, SignInError } from "../lib/session.ts";

type SessionState = {
  signedIn: boolean;
  /** True while a key stored before this load is being checked (at most RESTORE_LIMIT ms). */
  restoring: boolean;
  /** False once a request could not reach the server; true again on the next answer. */
  online: boolean;
} & ServerBuild;

type Session = SessionState & {
  /** Sign in with a typed key; `persist` also keeps it on this device. */
  signIn: (secret: string, persist: boolean) => Promise<void>;
  signOut: () => void;
  /**
   * Run `work` when the operator signs out, while the key is still set, so a page can end what it
   * started on the server. A rejected key signs out without it. Returns the unregister function.
   */
  beforeSignOut: (work: () => void) => () => void;
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
/** How long a stored key is checked before the sign-in form shows; a hung server counts as down. */
const RESTORE_LIMIT = 10_000;

type Open = (secret: string, signal?: AbortSignal) => Promise<void>;

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
 * Try the stored key once per load (the ref keeps StrictMode's second effect run out). A success
 * leaves it in whichever store it came from; a refused key is discarded from the stores holding
 * it; a server that cannot be reached within RESTORE_LIMIT or refuses for another reason keeps it
 * for the next load. `failed` runs on any failure.
 */
function useRestore(open: Open, failed: () => void) {
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const secret = recall();
    if (secret === null) return;
    open(secret, AbortSignal.timeout(RESTORE_LIMIT)).catch((error: unknown) => {
      if (error instanceof SignInError && error.reason === "rejected") discard(secret);
      failed();
    });
  }, [open, failed]);
}

/**
 * A sign-out in another tab cleared the stores; this tab follows, and a sign-in it is still checking
 * is cancelled. The signing-out tab hears its own message too, after it has already signed out.
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
 * The one session of this tab. Requests read the key from lib/api/client.ts memory; the stored
 * copy is lib/keyStore.ts's, written on a typed sign-in and read back once when the page loads.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState(() => ({ ...signedOut, restoring: recall() !== null }));
  const signedIn = useRef(false);
  const [leaving] = useState(() => new Set<() => void>());

  /** End the session in this tab only; the caller decides what happens to the stored key. */
  const endSession = useCallback(() => {
    closeSession();
    signedIn.current = false;
    // Every cached answer belongs to the old key.
    queryClient.clear();
    setState(signedOut);
  }, [queryClient]);

  useFollowSignOut(signedIn, endSession);

  // Only an explicit sign-out clears both stores and signs out the other tabs.
  const signOut = useCallback(() => {
    cancelSignIns();
    for (const work of leaving) work();
    forget();
    endSession();
  }, [leaving, endSession]);

  const beforeSignOut = useCallback(
    (work: () => void) => {
      leaving.add(work);
      return () => void leaving.delete(work);
    },
    [leaving],
  );

  const open = useCallback(
    async (secret: string, signal?: AbortSignal) => {
      const hooks: SessionHooks = {
        unauthorized() {
          if (!signedIn.current) return;
          // A rotated key: drop this one only, so a newer key another tab stored keeps working.
          discard(secret);
          endSession();
          notify("error", t("app.signIn.rejected"));
        },
        server(build) {
          setState((s) => withBuild(s, build));
        },
      };
      await openSession(secret, hooks, signal);
      signedIn.current = true;
      setState((s) => ({ ...s, signedIn: true, restoring: false }));
    },
    [endSession],
  );

  const signIn = useCallback(
    async (secret: string, persist: boolean) => {
      await open(secret);
      remember(secret, persist);
    },
    [open],
  );

  useRestore(
    open,
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
