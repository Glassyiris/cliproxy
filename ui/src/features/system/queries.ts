import { useQuery } from "@tanstack/react-query";
import { latestVersion } from "../../lib/api/system.ts";

const systemKeys = {
  latestVersion: ["system", "latest-version"] as const,
};

/** Nothing is checked until the user asks: the query stays idle until refetch(). */
export const useLatestVersion = () =>
  useQuery({
    queryKey: systemKeys.latestVersion,
    queryFn: async ({ signal }) => (await latestVersion(signal))["latest-version"] || "",
    enabled: false,
  });
