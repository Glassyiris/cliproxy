import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { listModelDefinitions } from "../../lib/api/routing.ts";
import type { Channel } from "./modelConfig.ts";

const modelKeys = {
  catalog: (channel: Channel) => ["models", "catalog", channel] as const,
};

/** The channel's static model catalog; one answer per channel, read on first use. */
export const useCatalog = (channel: Channel) =>
  useQuery({
    queryKey: modelKeys.catalog(channel),
    queryFn: async ({ signal }) => (await listModelDefinitions(channel, signal)).models ?? [],
  });

/** What a region needs of the config read to show its error and retry. */
export type ConfigRead = Pick<UseQueryResult, "isError" | "error" | "refetch">;
