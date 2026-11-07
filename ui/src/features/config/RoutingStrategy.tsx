import { useState } from "react";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { VStack } from "@astryxdesign/core/Layout";
import { useConfigWrite } from "../../app/serverQueries.ts";
import type { Action } from "../../app/useAction.ts";
import type { Config } from "../../lib/api/config.ts";
import { t } from "../../lib/i18n.ts";
import { strategies, strategy } from "../../lib/routing.ts";
import { layout } from "../../themes/site/layout.ts";

const text = {
  "round-robin": {
    name: () => t("config.strategy.roundRobin"),
    help: () => t("config.strategyHelp.roundRobin"),
  },
  "fill-first": {
    name: () => t("config.strategy.fillFirst"),
    help: () => t("config.strategyHelp.fillFirst"),
  },
  "weighted-round-robin": {
    name: () => t("config.strategy.weightedRoundRobin"),
    help: () => t("config.strategyHelp.weightedRoundRobin"),
  },
  "soonest-reset": {
    name: () => t("config.strategy.soonestReset"),
    help: () => t("config.strategyHelp.soonestReset"),
  },
};
type Value = keyof typeof text;

const name = (value: Value) => text[value].name();

export function RoutingStrategySkeleton() {
  return (
    <VStack gap={3} aria-busy>
      {strategies.map((s) => (
        <Skeleton
          key={s.value}
          width={layout.valueSkeleton.width}
          height={layout.valueSkeleton.height}
        />
      ))}
    </VStack>
  );
}

/** The strategy saves on change: one press is one reread, compare and write. */
export function RoutingStrategy({ config, action }: { config: Config; action: Action }) {
  const write = useConfigWrite(action);
  // Read as stored: an explicit null is a value the server compares against, an absent key is not.
  const saved = (config.routing as { strategy?: unknown } | null | undefined)?.strategy;
  const [chosen, setChosen] = useState<Value | null>(null);
  const current = strategy(saved, true).value;

  const choose = async (value: Value) => {
    if (chosen !== null || action.busy || value === current) return;
    setChosen(value);
    // An absent key reads back from the server as {}, which is what the write compares against.
    await write(
      "routing/strategy",
      saved === undefined ? {} : saved,
      value,
      t("config.routing.set", { name: name(value).toLowerCase() }),
    );
    setChosen(null);
  };

  return (
    <RadioList
      label={t("config.routing.heading")}
      isLabelHidden
      value={chosen ?? current}
      isDisabled={chosen !== null || action.busy}
      onChange={(value) => void choose(value as Value)}
    >
      {strategies.map((s) => (
        <RadioListItem
          key={s.value}
          value={s.value}
          label={name(s.value)}
          description={text[s.value].help()}
          endContent={
            chosen === s.value ? (
              <Spinner size="sm" aria-label={t("config.routing.saving")} />
            ) : undefined
          }
        />
      ))}
    </RadioList>
  );
}
