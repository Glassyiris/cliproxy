import { useEffect, useRef, useState } from "react";
import { useKeyTest, type KeyTest } from "../../app/useKeyTest.ts";

export type KeyChoice = {
  keys: string[];
  index: number;
  onIndex: (index: number) => void;
  models: string[];
  model: string;
  onModel: (model: string) => void;
  result: KeyTest;
  onTest: () => void;
};

/**
 * The client key and model the page shows, and the test of that key. The key is tested when it
 * changes; the answer of an earlier key is dropped by `useKeyTest`. The last model list the key
 * returned stays through re-tests and failures and is dropped only when the key changes, so the
 * chosen model survives them. `choice` is undefined while there is no key to offer.
 */
export function useKeyChoice(keys: string[] | undefined) {
  const { result, test } = useKeyTest();
  const [picked, setPicked] = useState(0);
  const [chosenModel, setChosenModel] = useState("");
  const [kept, setKept] = useState<{ key: string; models: string[] }>({ key: "", models: [] });
  const testedKey = useRef("");

  const index = Math.min(picked, (keys?.length ?? 1) - 1);
  const key = keys?.[index] ?? "";
  const models = kept.key === key ? kept.models : [];
  const model = models.includes(chosenModel) ? chosenModel : (models[0] ?? "");

  useEffect(() => {
    if (!key) return;
    testedKey.current = key;
    void test(key);
  }, [key, test]);

  useEffect(() => {
    if (result.status === "ready") setKept({ key: testedKey.current, models: result.models });
  }, [result]);

  const choice: KeyChoice | undefined = key
    ? {
        keys: keys ?? [],
        index,
        onIndex: setPicked,
        models,
        model,
        onModel: setChosenModel,
        result,
        onTest: () => {
          testedKey.current = key;
          void test(key);
        },
      }
    : undefined;
  return { key, model, choice };
}
