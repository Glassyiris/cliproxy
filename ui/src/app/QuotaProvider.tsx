import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CredentialList } from "../lib/api/credentials.ts";
import { createQuotaChecker } from "../lib/quota.ts";
import { serverKeys } from "./serverQueries.ts";

type QuotaChecker = ReturnType<typeof createQuotaChecker>;
const QuotaContext = createContext<QuotaChecker | null>(null);

/**
 * The tab's one quota checker. It lives as long as the signed-in shell, so signing out drops its
 * readings and the 2-minute spacing with the key. It reads accounts from the shared query, as
 * they are when a check is about to go out.
 */
export function QuotaProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [checker] = useState(() =>
    createQuotaChecker({
      credentials: () =>
        queryClient.getQueryData<CredentialList>(serverKeys.credentials)?.files ?? [],
    }),
  );
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = checker.subscribe(() => setVersion((v) => v + 1));
    // Unmounting (sign-out) drops the queued checks: none reads the cache or sends afterwards.
    return () => {
      unsubscribe();
      checker.stop();
    };
  }, [checker]);
  // A new value on every reading or pending change, so every reader rerenders with it.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the change signal
  const value = useMemo(() => ({ ...checker }), [checker, version]);
  return <QuotaContext value={value}>{children}</QuotaContext>;
}

/** Readings and pending state of this tab's quota checks, and the calls that start them. */
export function useQuota() {
  const value = use(QuotaContext);
  if (!value) throw new Error("useQuota outside QuotaProvider");
  return value;
}
