import { useCallback, useMemo } from "react";
import { useApiKeyUsage, useConfig } from "../../app/serverQueries.ts";
import { usePreferences } from "../../app/preferences.ts";
import { t } from "../../lib/i18n.ts";
import {
  busiest,
  groupNames,
  groupsOf,
  keyTraffic,
  storedGroups,
  type Family,
  type Group,
  type Key,
} from "./groups.ts";

/**
 * The reads of one family: its groups as stored, their unique names, and per-key traffic. While
 * the usage query is in error the report it kept from an earlier poll is stale, so no traffic and
 * no busiest bucket come out of it.
 */
export function useFamily(family: Family) {
  const config = useConfig();
  const usage = useApiKeyUsage({ poll: true });
  const { locale } = usePreferences();
  const stored = config.data ? storedGroups(config.data, family) : undefined;
  const groups = stored === undefined ? undefined : groupsOf(stored);
  const report = usage.isError ? undefined : usage.data;
  const names = useMemo(
    () => groupNames(groups ?? [], (n) => t("providers.group.unnamed", { n })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale changes what t() returns
    [groups, locale],
  );
  const traffic = useCallback(
    (group: Group, key: Key) => keyTraffic(report, family, group, key),
    [report, family],
  );
  const max = useMemo(() => busiest(report, family, groups ?? []), [report, family, groups]);
  return { config, usage, groups, names, traffic, max };
}
