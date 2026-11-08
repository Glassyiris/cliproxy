import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAvailable } from "../../components/MissingActions.tsx";
import { listErrorLogs, readLogs, readRequestLog } from "../../lib/api/logs.ts";
import { routes } from "../../lib/api/routes.ts";
import { appendPage, type Tail } from "./lines.ts";

export const logKeys = {
  tail: ["logs", "tail"] as const,
  requests: ["logs", "request"] as const,
  request: (id: string) => ["logs", "request", id] as const,
  errors: ["logs", "errors"] as const,
};

const FOLLOW_MS = 3_000;
const PAGE_LINES = 300;

/**
 * The application log tail: each read asks only for lines after the last one this tab holds.
 * While following it is read every 3 s, paused while the tab is hidden and reread when it is
 * shown again; paused, it is not read at all. While its page tab is not shown (`isShown`, the
 * Error logs tab is open) it is not read either, not even once on entry.
 */
export function useLogTail(isFollowing: boolean, isShown: boolean) {
  const client = useQueryClient();
  const isAvailable = useAvailable();
  const polls = isShown && isFollowing && isAvailable(routes.readLogs);
  return useQuery({
    queryKey: logKeys.tail,
    queryFn: async ({ signal }): Promise<Tail> => {
      const prev = client.getQueryData<Tail>(logKeys.tail);
      const page = await readLogs({ limit: PAGE_LINES, cursor: prev?.cursor || undefined }, signal);
      return appendPage(prev, page);
    },
    enabled: isShown,
    refetchInterval: polls ? FOLLOW_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: polls,
    staleTime: FOLLOW_MS,
  });
}

export const useRequestLog = (id: string) =>
  useQuery({
    queryKey: logKeys.request(id),
    queryFn: ({ signal }) => readRequestLog(id, signal),
    enabled: !!id,
  });

/** Read each time the Error logs tab opens. */
export const useErrorLogs = () =>
  useQuery({
    queryKey: logKeys.errors,
    queryFn: async ({ signal }) => (await listErrorLogs(signal)).files ?? [],
  });
