import { t } from "./i18n.ts";

/** routing.strategy values, in the order the dashboard offers them. */
export const strategies = [
  "round-robin",
  "fill-first",
  "weighted-round-robin",
  "soonest-reset",
] as const;
export type Strategy = (typeof strategies)[number];

// Round robin needs no explanation beyond its name.
const words: Record<Strategy, { name: () => string; help?: () => string }> = {
  "round-robin": {
    name: () => t("app.strategy.roundRobin"),
  },
  "fill-first": {
    name: () => t("app.strategy.fillFirst"),
    help: () => t("app.strategyHelp.fillFirst"),
  },
  "weighted-round-robin": {
    name: () => t("app.strategy.weightedRoundRobin"),
    help: () => t("app.strategyHelp.weightedRoundRobin"),
  },
  "soonest-reset": {
    name: () => t("app.strategy.soonestReset"),
    help: () => t("app.strategyHelp.soonestReset"),
  },
};

export const strategyName = (s: Strategy) => words[s].name();
/** A strategy's one-line explanation in the current language, where its name is not enough. */
export const strategyHelp = (s: Strategy) => words[s].help?.();

/** The strategy a configured value selects, aliases included, as cook-router reads it: unset is soonest reset; anything else unknown is round robin. */
export function strategy(value: unknown): Strategy {
  const v =
    String(value ?? "")
      .trim()
      .toLowerCase() || "soonest-reset";
  const alias: Record<string, Strategy> = {
    rr: "round-robin",
    roundrobin: "round-robin",
    ff: "fill-first",
    fillfirst: "fill-first",
    wrr: "weighted-round-robin",
    weightedroundrobin: "weighted-round-robin",
    "reset-first": "soonest-reset",
  };
  return strategies.find((s) => s === (alias[v] || v)) || "round-robin";
}
