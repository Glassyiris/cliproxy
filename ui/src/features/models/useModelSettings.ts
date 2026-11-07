import { useConfig, useConfigWrite } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { t } from "../../lib/i18n.ts";
import { configPath, readList, type Alias, type Channel } from "./modelConfig.ts";

/** One channel's aliases and exclusions from the config, with the stale-checked writes. */
export function useModelSettings(channel: Channel) {
  const config = useConfig();
  const action = useAction();
  const write = useConfigWrite(action);
  const aliasRead = config.data ? readList<Alias>(config.data, "model-alias", channel) : undefined;
  const excludedRead = config.data
    ? readList<string>(config.data, "excluded-models", channel)
    : undefined;
  const aliasPath = configPath("model-alias", channel);
  const excludedPath = configPath("excluded-models", channel);

  return {
    config,
    busy: action.busy,
    aliases: aliasRead?.list,
    excluded: excludedRead?.list,
    addAlias: async (alias: Alias) =>
      !!aliasRead &&
      (await write(
        aliasPath,
        aliasRead.stored,
        [...aliasRead.list, alias],
        t("models.add.added", { alias: alias.alias }),
      )),
    removeAlias: async (index: number) =>
      !!aliasRead &&
      (await write(
        aliasPath,
        aliasRead.stored,
        aliasRead.list.filter((_, i) => i !== index),
        t("models.alias.removed", { model: aliasRead.list[index].name }),
      )),
    exclude: async (pattern: string) =>
      !!excludedRead &&
      (await write(
        excludedPath,
        excludedRead.stored,
        [...excludedRead.list, pattern],
        t("models.excluded.added", { model: pattern }),
      )),
    allow: async (index: number) =>
      !!excludedRead &&
      (await write(
        excludedPath,
        excludedRead.stored,
        excludedRead.list.filter((_, i) => i !== index),
        t("models.excluded.allowed", { model: excludedRead.list[index] }),
      )),
  };
}
