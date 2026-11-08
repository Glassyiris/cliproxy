import { label } from "../../lib/credentials.ts";
import { channels, matchesQuery, modelRows, ruleRows, type Channel } from "./modelConfig.ts";
import { useCatalogs } from "./queries.ts";
import type { ModelSettings } from "./useModelSettings.ts";

/**
 * The rows of both views for the chosen families and search. Models wait for the config (their
 * aliases and exclusions come from it) and for every catalog to answer, so rows never pop in; a family whose catalog
 * cannot be read is listed in `failed` and the others still show.
 */
export function useModelRows(settings: ModelSettings, family: Channel | undefined, query: string) {
  const families = family ? [family] : channels;
  const catalogs = useCatalogs(families);
  const { aliases, excluded } = settings;
  const config = settings.config.data;
  const failed = families.filter((_, i) => catalogs[i].isError);
  const isWaiting = catalogs.some((c) => c.isPending);
  // A few hundred rows at most: rebuilt each render, as cheap as comparing their inputs.
  const models =
    config && !isWaiting
      ? families
          .flatMap((channel, i) =>
            modelRows(
              channel,
              catalogs[i].data ?? [],
              aliases(channel) ?? [],
              excluded(channel) ?? [],
            ),
          )
          .filter((row) => matchesQuery([row.id, row.name, ...row.aliases], query))
      : undefined;
  const rules = config
    ? families
        .flatMap((channel) => ruleRows(channel, aliases(channel) ?? [], excluded(channel) ?? []))
        .filter((row) => matchesQuery([row.pattern, row.alias], query))
    : undefined;

  return {
    models,
    rules,
    failed,
    failedNames: failed.map(label).join(", "),
    failure: catalogs.find((c) => c.isError)?.error,
    retry: () => catalogs.forEach((c) => c.isError && void c.refetch()),
    modelsOf: (channel: Channel) =>
      catalogs[families.indexOf(channel)]?.data?.map((m) => m.id) ?? [],
  };
}
