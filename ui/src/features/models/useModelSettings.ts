import { useConfig, useConfigWrite } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { t } from "../../lib/i18n.ts";
import { configPath, readList, type Alias, type Channel } from "./modelConfig.ts";

/** One channel's aliases and exclusions from the config, with the stale-checked writes. */
export function useModelSettings(channel: Channel) {
  const config = useConfig();
  const action = useAction();
  const write = useConfigWrite(action);
  const aliases = config.data ? readList<Alias>(config.data, "model-alias", channel) : undefined;
  const excluded = config.data
    ? readList<string>(config.data, "excluded-models", channel)
    : undefined;
  const aliasPath = configPath("model-alias", channel);
  const excludedPath = configPath("excluded-models", channel);

  return {
    config,
    busy: action.busy,
    aliases,
    excluded,
    addAlias: async (alias: Alias) =>
      !!aliases &&
      (await write(aliasPath, [...aliases, alias], t("models.add.added", { alias: alias.alias }))),
    removeAlias: async (index: number) =>
      !!aliases &&
      (await write(
        aliasPath,
        aliases.filter((_, i) => i !== index),
        t("models.alias.removed", { model: aliases[index].name }),
      )),
    exclude: async (pattern: string) =>
      !!excluded &&
      (await write(
        excludedPath,
        [...excluded, pattern],
        t("models.excluded.added", { model: pattern }),
      )),
    allow: async (index: number) =>
      !!excluded &&
      (await write(
        excludedPath,
        excluded.filter((_, i) => i !== index),
        t("models.excluded.allowed", { model: excluded[index] }),
      )),
  };
}
