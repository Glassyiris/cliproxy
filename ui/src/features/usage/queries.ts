import { useEffect, useState, useSyncExternalStore } from "react";
import { focusManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { drainUsageQueue, type UsageRecord } from "../../lib/api/observability.ts";

const DRAIN_MS = 3_000;
const queueKey = ["usage", "queue"] as const;

/** Whether the tab is shown, as TanStack's own focus manager tracks it from visibilitychange. */
const useShown = () =>
  useSyncExternalStore(
    (changed) => focusManager.subscribe(changed),
    () => focusManager.isFocused(),
  );

/**
 * While `live` and the tab is shown, takes up to 500 records off the server's usage queue every
 * 3 s, and once more when the tab is shown again. Reading removes the records for every reader,
 * so each answer is handed to `onBatch` exactly once instead of being cached, and a failure is not
 * retried: `onError` ends the live view. Stopping or leaving cancels the pending read, including
 * one paused while offline, and an answer from a stopped run is dropped.
 */
export function useUsageDrain({
  live,
  onBatch,
  onError,
}: {
  live: boolean;
  onBatch: (batch: (UsageRecord | string)[]) => void;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const shown = useShown();
  const [run] = useState(() => ({ id: 0 }));
  useEffect(() => {
    if (!live) return;
    return () => {
      run.id++;
      void queryClient.cancelQueries({ queryKey: queueKey });
    };
  }, [live, queryClient, run]);
  useQuery({
    queryKey: queueKey,
    queryFn: async ({ signal }) => {
      const started = run.id;
      try {
        const batch = await drainUsageQueue(500, signal);
        if (started === run.id) onBatch(batch);
        return batch.length;
      } catch (error) {
        if (started === run.id && !signal.aborted) onError(error);
        throw error;
      }
    },
    // Reconnect and interval reads both pass through `enabled`, so neither runs while hidden.
    enabled: live && shown,
    refetchInterval: DRAIN_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    gcTime: 0,
  });
}
