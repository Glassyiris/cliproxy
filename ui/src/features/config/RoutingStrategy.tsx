import { useState } from "react";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { VStack } from "@astryxdesign/core/Layout";
import { useConfigWrite } from "../../app/serverQueries.ts";
import type { Action } from "../../app/useAction.ts";
import type { Config } from "../../lib/api/config.ts";
import { t } from "../../lib/i18n.ts";
import {
  strategies,
  strategy,
  strategyHelp,
  strategyName,
  type Strategy,
} from "../../lib/routing.ts";
import { layout } from "../../themes/site/layout.ts";

export function RoutingStrategySkeleton() {
  return (
    <VStack gap={3} aria-busy>
      {strategies.map((s) => (
        <Skeleton key={s} width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
      ))}
    </VStack>
  );
}

/** The strategy saves on change: one press is one reread, compare and write. */
export function RoutingStrategy({ config, action }: { config: Config; action: Action }) {
  const write = useConfigWrite(action);
  const saved = (config.routing as { strategy?: unknown } | null | undefined)?.strategy;
  const [chosen, setChosen] = useState<Strategy | null>(null);
  const current = strategy(saved);

  const choose = async (value: Strategy) => {
    if (chosen !== null || action.busy || value === current) return;
    setChosen(value);
    await write(
      "routing/strategy",
      value,
      t("config.routing.set", { name: strategyName(value).toLowerCase() }),
    );
    setChosen(null);
  };

  return (
    <RadioList
      label={t("config.routing.heading")}
      isLabelHidden
      value={chosen ?? current}
      isDisabled={chosen !== null || action.busy}
      onChange={(value) => void choose(value as Strategy)}
    >
      {strategies.map((s) => (
        <RadioListItem
          key={s}
          value={s}
          label={strategyName(s)}
          description={strategyHelp(s)}
          endContent={
            chosen === s ? <Spinner size="sm" aria-label={t("config.routing.saving")} /> : undefined
          }
        />
      ))}
    </RadioList>
  );
}
