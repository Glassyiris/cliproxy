import { useQuery } from "@tanstack/react-query";
import { readConfig } from "../../lib/api/config.ts";
import { latestVersion } from "../../lib/api/system.ts";

const systemKeys = {
  config: ["system", "config"] as const,
  latestVersion: ["system", "latest-version"] as const,
};

export const useConfig = () =>
  useQuery({ queryKey: systemKeys.config, queryFn: ({ signal }) => readConfig(signal) });

/** Nothing is checked until the user asks: the query stays idle until refetch(). */
export const useLatestVersion = () =>
  useQuery({
    queryKey: systemKeys.latestVersion,
    queryFn: async ({ signal }) => (await latestVersion(signal))["latest-version"] || "",
    enabled: false,
  });
