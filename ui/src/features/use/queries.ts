import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { listClientModels } from "../../lib/api/proxy.ts";

const modelKeys = {
  models: (key: string) => ["use", "models", key] as const,
};

/**
 * The models a client key reaches, cached per key. While another key's list loads, the previous
 * list stays as placeholder data, so the model control never empties and the snippet keeps a model.
 */
export const useClientModels = (key: string) =>
  useQuery({
    queryKey: modelKeys.models(key),
    queryFn: ({ signal }) => listClientModels(key, signal),
    enabled: key !== "",
    placeholderData: keepPreviousData,
  });
