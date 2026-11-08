import { useQueries } from "@tanstack/react-query";
import { listModelDefinitions } from "../../lib/api/routing.ts";
import type { Channel } from "./modelConfig.ts";

const catalogKey = (channel: Channel) => ["models", "catalog", channel] as const;

/** Each family's static model catalog, one request per family, read on first use. */
export const useCatalogs = (families: readonly Channel[]) =>
  useQueries({
    queries: families.map((channel) => ({
      queryKey: catalogKey(channel),
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await listModelDefinitions(channel, signal)).models ?? [],
    })),
  });
