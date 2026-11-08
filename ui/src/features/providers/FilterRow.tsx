// Provider keys' filter row and list body, as Accounts lays out its own: the views, the family and
// status Selectors and the search in one row; then the list, its skeleton, or why it is empty.
import { icons } from "../../components/icons.ts";
import { ListFilters } from "../../components/ListFilters.tsx";
import type { ReactNode } from "react";
import { Icon } from "@astryxdesign/core/Icon";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { CountedSelector } from "../../components/CountedSelector.tsx";
import { familyName, isFamily } from "../../components/keyFamilies.ts";
import { providerIcon } from "../../components/ProviderIcon.tsx";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { countBy, inScope, isShow, showOf, shows } from "./list.ts";
import type { Page } from "./ProviderKeys.tsx";
import { ProviderTable, ProviderTableSkeleton } from "./ProviderTable.tsx";
import { showWord } from "./words.ts";

/** The family and status Selectors, each option with how many groups it keeps. */
function FilterSelectors({ page }: { page: Page }) {
  const { entries = [], filters, setFilters } = page;
  const familyCounts = countBy(entries, (e) => e.family);
  // Each status as it would narrow the current family and search.
  const statusCounts = countBy(
    inScope(entries, { provider: filters.provider, show: "", search: filters.search }),
    showOf,
  );
  return (
    <>
      <CountedSelector
        label={t("app.list.family")}
        allLabel={t("app.list.allFamilies")}
        value={filters.provider}
        onChange={(p) => setFilters({ provider: isFamily(p) ? p : "" })}
        options={[...familyCounts].map(([f, count]) => ({
          value: f,
          label: familyName(f),
          icon: providerIcon(f),
          count,
        }))}
      />
      <CountedSelector
        label={t("app.list.status")}
        allLabel={t("app.list.anyStatus")}
        value={filters.show}
        onChange={(s) =>
          // A serving group is out of the "needs attention" view, so picking it shows all.
          setFilters(
            isShow(s) ? { show: s, ...(s === "ready" ? { view: "all" } : {}) } : { show: "" },
          )
        }
        options={shows.map((s) => ({
          value: s,
          label: showWord(s),
          count: statusCounts.get(s) ?? 0,
        }))}
      />
    </>
  );
}

/** The views, the Selectors and the search; on a phone the views take their own line. */
export function FilterRow({ page }: { page: Page }) {
  const { filters, setFilters } = page;
  return (
    <ListFilters
      filters={filters}
      setFilters={setFilters}
      needs={page.needs}
      total={page.scope.length}
      isStacked={page.shape === "stacked"}
      searchLabel={t("providers.filters.search")}
      searchHint={t("providers.filters.searchHint")}
      selectors={<FilterSelectors page={page} />}
    />
  );
}

/** Why the views leave no rows, and the way back to rows. */
function EmptyView({ page }: { page: Page }) {
  const { filters, setFilters } = page;
  const filtered = !!(filters.provider || filters.show || filters.search);
  if (!filtered && filters.view === "needs")
    return (
      <EmptyState
        icon={<Icon icon={icons.allClear} size="lg" />}
        title={t("providers.empty.allServe")}
        description={t("providers.empty.allServeDetail")}
        headingLevel={roles.heading.section}
        actions={
          <Button
            label={t("providers.empty.showAll")}
            onClick={() => setFilters({ view: "all" })}
          />
        }
      />
    );
  return (
    <EmptyState
      icon={<Icon icon={icons.search} size="lg" />}
      title={t("providers.empty.noMatch")}
      headingLevel={roles.heading.section}
      actions={
        <Button
          label={t("app.list.clear")}
          onClick={() => setFilters({ provider: "", show: "", search: "" })}
        />
      }
    />
  );
}

/** The list, its skeleton, or why it is empty. */
export function ProviderList({ page, addMenu }: { page: Page; addMenu: ReactNode }) {
  const { config, entries, shown } = page;
  if (config.isPending) return <ProviderTableSkeleton shape={page.shape} />;
  if (!entries) return null;
  if (!entries.length)
    return (
      <EmptyState
        icon={<Icon icon={icons.providerKeys} size="lg" />}
        title={t("providers.empty.title")}
        headingLevel={roles.heading.section}
        actions={addMenu}
      />
    );
  if (!shown.length) return <EmptyView page={page} />;
  return (
    <ProviderTable
      shown={shown}
      openId={page.openId}
      onOpen={page.onOpen}
      trafficPending={page.usage.isPending}
      shape={page.shape}
    />
  );
}
