import { useState } from "react";
import { useAction } from "../../app/useAction.ts";
import { revealClientKey, type ClientKey } from "../../lib/api/clientKeys.ts";
import { isUsableSecret } from "../../lib/api/config.ts";
import { useClientModels } from "./queries.ts";

export type KeyChoice = {
  key: string;
  id: string | undefined;
  reveal: (id?: string) => Promise<string>;
  revealing: boolean;
  models: string[];
  model: string;
  onModel: (model: string) => void;
  checking: boolean;
  failed: boolean;
};
type RevealedKey = { id: string; rev: number; key: string };

export const selectedClientKey = (keys: ClientKey[] | undefined, id: string | undefined) =>
  keys?.find((resource) => resource.id === id) ?? keys?.[0];

export function selectedPlaintext(
  resource: ClientKey | undefined,
  revealed: RevealedKey | undefined,
) {
  return resource &&
    revealed?.id === resource.id &&
    revealed.rev === resource.rev &&
    isUsableSecret(revealed.key)
    ? revealed.key
    : "";
}

/** Plaintext stays in this dialog and is fetched only by an explicit action. */
export function useKeyChoice(keys: ClientKey[] | undefined, param: string | undefined) {
  const [chosenModel, setChosenModel] = useState("");
  const [revealed, setRevealed] = useState<RevealedKey>();
  const action = useAction();
  const resource = selectedClientKey(keys, param);
  const key = selectedPlaintext(resource, revealed);
  const query = useClientModels(key, resource);
  const models = query.data ?? [];
  const reveal = async (id = resource?.id) => {
    const target = keys?.find((entry) => entry.id === id);
    if (!target) return "";
    const cached = selectedPlaintext(target, revealed);
    if (cached) return cached;
    let plaintext = "";
    await action.run(async () => {
      const value = await revealClientKey(target.id);
      plaintext = value;
      setRevealed({ id: target.id, rev: target.rev, key: value });
    });
    return plaintext;
  };
  return {
    key,
    id: resource?.id,
    reveal,
    revealing: action.busy,
    models,
    model: models.includes(chosenModel) ? chosenModel : (models[0] ?? ""),
    onModel: setChosenModel,
    checking: query.isFetching,
    failed: query.isError && !query.isFetching,
  };
}
