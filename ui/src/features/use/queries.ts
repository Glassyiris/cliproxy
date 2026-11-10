import { useQuery } from "@tanstack/react-query";
import type { ClientKey } from "../../lib/api/clientKeys.ts";
import { isUsableSecret } from "../../lib/api/config.ts";
import { listClientModels } from "../../lib/api/proxy.ts";

const modelKeys = {
  models: (resource?: ClientKey) => ["use", "models", resource?.id, resource?.rev] as const,
};

/** Model results are cached by resource identity, without retaining plaintext in query keys. */
export const useClientModels = (key: string, resource: ClientKey | undefined) =>
  useQuery({
    queryKey: modelKeys.models(resource),
    queryFn: ({ signal }) => listClientModels(key, signal),
    enabled: isUsableSecret(key),
    gcTime: 0,
  });
