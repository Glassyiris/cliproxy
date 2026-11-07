import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { t } from "../lib/i18n.ts";
import { notify } from "../lib/notify.ts";
import type { ServerBuild } from "../lib/api/client.ts";
import { closeSession, openSession } from "../lib/session.ts";

type SessionState = {
  signedIn: boolean;
  /** False once a request could not reach the server; true again on the next answer. */
  online: boolean;
} & ServerBuild;

type Session = SessionState & {
  signIn: (secret: string) => Promise<void>;
  signOut: () => void;
};

const signedOut: SessionState = {
  signedIn: false,
  online: true,
  version: "",
  commit: "",
  built: "",
};
const SessionContext = createContext<Session | null>(null);

/** The one session of this tab. The key itself stays in lib/api/client.ts memory, never here. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState(signedOut);
  const signedIn = useRef(false);

  const signOut = useCallback(() => {
    closeSession();
    signedIn.current = false;
    // Every cached answer belongs to the old key.
    queryClient.clear();
    setState(signedOut);
  }, [queryClient]);

  const signIn = useCallback(
    async (secret: string) => {
      await openSession(secret, {
        unauthorized() {
          if (!signedIn.current) return;
          signOut();
          notify("error", t("app.signIn.rejected"));
        },
        server(build) {
          setState((s) => {
            if (build === null) return s.online ? { ...s, online: false } : s;
            // Bare answers (the server's own 404 for an unknown route) carry no build headers.
            const bare = !build.version && !build.commit && !build.built;
            const next = bare ? { version: s.version, commit: s.commit, built: s.built } : build;
            const same =
              s.version === next.version && s.commit === next.commit && s.built === next.built;
            return s.online && same ? s : { ...s, ...next, online: true };
          });
        },
      });
      signedIn.current = true;
      setState((s) => ({ ...s, signedIn: true }));
    },
    [signOut],
  );

  const value = useMemo(() => ({ ...state, signIn, signOut }), [state, signIn, signOut]);
  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession() {
  const value = use(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}
