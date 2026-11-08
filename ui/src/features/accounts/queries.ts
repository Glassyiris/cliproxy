import { useQuery } from "@tanstack/react-query";
import { listCredentialModels } from "../../lib/api/credentials.ts";

const accountKeys = {
  models: (id: string) => ["accounts", "models", id] as const,
};

/** The models one account can serve, read when its panel opens. */
export const useCredentialModels = (id: string) =>
  useQuery({
    queryKey: accountKeys.models(id),
    queryFn: async ({ signal }) => (await listCredentialModels(id, signal)).models,
  });
