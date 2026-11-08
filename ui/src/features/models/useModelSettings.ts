import { useConfig, useConfigWrite } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { t } from "../../lib/i18n.ts";
import {
  configPath,
  readList,
  type Alias,
  type Channel,
  type RuleRow,
  type Section,
} from "./modelConfig.ts";

/** Each family's aliases and exclusions from the config, with the stale-checked writes. */
export function useModelSettings() {
  const config = useConfig();
  const action = useAction();
  const write = useConfigWrite(action);
  const data = config.data;
  const listOf = <T>(section: Section, channel: Channel) =>
    data ? readList<T>(data, section, channel) : undefined;
  const aliases = (channel: Channel) => listOf<Alias>("model-alias", channel);
  const excluded = (channel: Channel) => listOf<string>("excluded-models", channel);

  return {
    config,
    busy: action.busy,
    aliases,
    excluded,
    addAlias: async (channel: Channel, alias: Alias) => {
      const list = aliases(channel);
      if (!list) return false;
      const done = t("models.add.added", { alias: alias.alias });
      return write(configPath("model-alias", channel), [...list, alias], done);
    },
    exclude: async (channel: Channel, pattern: string) => {
      const list = excluded(channel);
      if (!list) return false;
      const done = t("models.exclude.added", { model: pattern });
      return write(configPath("excluded-models", channel), [...list, pattern], done);
    },
    /** Writes the family's list without the row's entry; true when it was stored. */
    removeRule: async (row: RuleRow) => {
      const section = row.kind === "alias" ? "model-alias" : "excluded-models";
      const list = listOf<unknown>(section, row.channel);
      if (!list) return false;
      const done =
        row.kind === "alias"
          ? t("models.rules.aliasRemoved", { alias: row.alias ?? "" })
          : t("models.rules.allowed", { model: row.pattern });
      const next = list.filter((_, i) => i !== row.index);
      return write(configPath(section, row.channel), next, done);
    },
  };
}

export type ModelSettings = ReturnType<typeof useModelSettings>;
