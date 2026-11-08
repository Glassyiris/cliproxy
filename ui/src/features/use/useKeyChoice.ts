import { useState } from "react";
import { useClientModels } from "./queries.ts";

export type KeyChoice = ReturnType<typeof useKeyChoice>;

/**
 * The client key and model the dialog shows. `param` is the key's position from the hash (a key
 * row opens the dialog with its own); a missing or stale position reads as the first key. The
 * chosen model survives a key change when the new key reaches it too.
 */
export function useKeyChoice(keys: string[] | undefined, param: string | undefined) {
  const [chosenModel, setChosenModel] = useState("");
  const count = keys?.length ?? 0;
  const asked = Number(param);
  const index = Number.isInteger(asked) && asked >= 0 && asked < count ? asked : 0;
  const key = keys?.[index] ?? "";
  const query = useClientModels(key);
  const models = query.data ?? [];
  return {
    key,
    index,
    models,
    model: models.includes(chosenModel) ? chosenModel : (models[0] ?? ""),
    onModel: setChosenModel,
    /** The list on screen belongs to another key, or no answer has arrived yet. */
    checking: query.isFetching,
    failed: query.isError && !query.isFetching,
  };
}
