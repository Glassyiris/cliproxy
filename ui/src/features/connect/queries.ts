import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { serverKeys } from "../../app/serverQueries.ts";
import { failureNotice } from "../../app/useAction.ts";
import type { Credential } from "../../lib/api/credentials.ts";
import { listCredentials } from "../../lib/api/credentials.ts";
import { oauthStatus } from "../../lib/api/oauth.ts";
import { forgottenAccount, type Seen } from "./flow.ts";

const connectKeys = {
  status: (id: number) => ["connect", "status", id] as const,
  gone: ["connect", "gone"] as const,
};

/**
 * The ways this server answered as not available (a provider, or "vertex"), kept in the query cache
 * until sign-out so the next opening of the dialog draws them disabled from the start.
 */
export function useGone() {
  const queryClient = useQueryClient();
  const gone = useQuery({
    queryKey: connectKeys.gone,
    queryFn: () => [] as string[],
    initialData: [] as string[],
    staleTime: Infinity,
    gcTime: Infinity,
  }).data;
  const add = (way: string) =>
    queryClient.setQueryData<string[]>(connectKeys.gone, (list = []) => [...list, way]);
  return [gone, add] as const;
}

/**
 * What one status read says about a sign-in, with the server's forgetting already resolved. Only
 * the server's own answer is here: a read that fails throws, and the sign-in keeps waiting.
 */
export type StatusAnswer =
  | { status: "wait" }
  | { status: "ok"; account: Credential | null; found: boolean }
  | { status: "error"; error: string }
  | { status: "unknown" };

/** The fields of a sign-in a status read needs. */
export type Polled = { id: number; provider: string; state: string; seen: Seen | null };

/** The message a failed request carries, worded as useAction words it. */
export const reason = (e: unknown) =>
  failureNotice(e)?.message ?? (e instanceof Error ? e.message : String(e));

/** This server's credentials now, or null when they cannot be read. */
const currentCredentials = () =>
  listCredentials().then(
    (r) => r.files,
    () => null,
  );

/** The credentials by name before a sign-in starts, to recognise its account later. */
export const credentialNames = async (): Promise<Seen | null> => {
  const files = await currentCredentials();
  return files && new Map(files.map((c) => [c.name, c]));
};

/** Reread the shared account list, so the quota checker finds the new account in it. */
export const reloadCredentials = (queryClient: QueryClient) =>
  queryClient.fetchQuery({
    queryKey: serverKeys.credentials,
    queryFn: ({ signal }) => listCredentials(signal),
    staleTime: 0,
  });

async function readStatus(flow: Polled, signal: AbortSignal): Promise<StatusAnswer> {
  const r = await oauthStatus(flow.state, signal);
  if (r.status !== "error")
    return r.status === "ok" ? { status: "ok", account: null, found: false } : { status: "wait" };
  // cliproxy-rs keeps a finished sign-in's result for 30 minutes; Go and older servers forget a
  // successful one after a minute. Then only a new name, read successfully, says it worked.
  if (r.error !== "unknown or expired state") return { status: "error", error: r.error };
  const now = (await listCredentials(signal)).files;
  const account = forgottenAccount(flow.provider, flow.seen, now);
  return account ? { status: "ok", account, found: true } : { status: "unknown" };
}

/**
 * The status of the waiting sign-in, every 2 s while the tab is shown and at once when it is
 * shown again. A failed read stops the polling until `refetch`. Each answer goes to `onAnswer`
 * with the sign-in it was read for, so an answer for a replaced sign-in can be told apart.
 */
export const useSignInStatus = (
  flow: Polled | null,
  waiting: boolean,
  onAnswer: (id: number, answer: StatusAnswer) => void,
) =>
  useQuery({
    queryKey: connectKeys.status(flow?.id ?? 0),
    queryFn: async ({ signal }) => {
      const answer = await readStatus(flow!, signal);
      onAnswer(flow!.id, answer);
      return answer;
    },
    enabled: !!flow && waiting,
    refetchInterval: (query) => (query.state.status === "error" ? false : 2_000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
