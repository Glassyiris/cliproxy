// Accounts, from the table-inbox template: which accounts cannot serve, and when they come back.
// The header holds the h1, Connect account as the one primary action, and the
// inbox's views; the list indexes the detail, which opens beside it (a bottom sheet on phones).
// Deviations from the template, each with its reason:
// - The views ("Needs attention", "All") are a SegmentedControl in the header's filter row, not
//   a TabList: a tab strip reads as switching place, which is the side nav's job (R-addendum-nav),
//   and a choice inside one view is a SegmentedControl or Select in its toolbar.
// - The family and the status filters are one Selector each beside the views; an Overview card's
//   reason (`?show=<reason>`) lands in the status Selector, whose first option clears it. The
//   template has one dimension of views, the accounts list has three (family, view, status). The
//   views' counts show on the row; the per-family and per-status counts only in the open menus.
// - The selection band replaces the filter row in place, as the template swaps it for the tabs,
//   so ticking a box never moves the list under the pointer.
// - No hover row actions: a 1,000-row list would mount four buttons per row; the batch band and
//   the detail panel carry the actions.
// - The reading pane is the shared detail panel (`roles.detailPanel`, a BottomSheet on phones),
//   not the template's two-thirds pane: the list is what this page is for, the detail is short.
// - The list is virtualized (DESIGN.md "Pages"), as LogRows.tsx does it.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Search } from "lucide-react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useConnectAccount } from "../../app/connect-entry.ts";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useQuota } from "../../app/QuotaProvider.tsx";
import { useCredentials, usePlugins } from "../../app/serverQueries.ts";
import { useHashParams, useHashRoute } from "../../app/useHashRoute.ts";
import { CountedSelector } from "../../components/CountedSelector.tsx";
import { MissingActions, useAvailable } from "../../components/MissingActions.tsx";
import { useListShape, type ListShape } from "../../components/listShape.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { routes } from "../../lib/api/routes.ts";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { AccountPanel } from "./AccountPanel.tsx";
import { AccountTable, LoadingTable } from "./AccountTable.tsx";
import { BatchBar } from "./BatchBar.tsx";
import {
  countBy,
  familiesOf,
  hasShow,
  inScope,
  inView,
  isShow,
  shows,
  toRows,
  type Filters,
  type Row,
} from "./rows.ts";
import { showWord } from "./words.ts";
import { useWrites, type Writes } from "./writes.tsx";

const missing = () => [
  { route: routes.uploadCredentials, label: t("accounts.missing.upload") },
  { route: routes.refreshCredentials, label: t("accounts.missing.refresh") },
  { route: routes.setCredentialStatus, label: t("accounts.missing.status") },
  { route: routes.setCredentialFields, label: t("accounts.missing.fields") },
  { route: routes.deleteCredentials, label: t("accounts.missing.delete") },
  { route: routes.resetCooldown, label: t("accounts.missing.cooldown") },
  { route: routes.callProvider, label: t("accounts.missing.quota") },
  { route: routes.resetPluginQuota, label: t("accounts.missing.stored") },
];

/**
 * The page's one clock: row countdowns, the panel and the 2-minute quota wait read it. It ticks
 * every second while a panel is open, whose waits count seconds, and every 15 s otherwise, which
 * the rows' minutes need; a tick rebuilds all rows, so idle CPU stays within the baseline.
 */
function useNow(isFast: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), isFast ? 1000 : 15_000);
    return () => clearInterval(id);
  }, [isFast]);
  return now;
}

/**
 * The filters and the open row, kept in the hash (`#accounts/<id>?provider=codex&list=all&show=
 * cooling&q=`). `view` names the route's view (Accounts, Provider keys), so the inbox view is `list`.
 */
function useFilters() {
  const [params, setParams] = useHashParams();
  const { arg } = useHashRoute();
  const filters: Filters = {
    provider: params.provider ?? "",
    view: params.list === "all" ? "all" : "needs",
    show: isShow(params.show) ? params.show : "",
    search: params.q ?? "",
  };
  const setFilters = (f: Partial<Filters>) => setParams(pick(f), "replace");
  const query = new URLSearchParams(params).toString();
  const go = useCallback(
    (id: string) => {
      location.hash = `#accounts${id ? `/${encodeURIComponent(id)}` : ""}${query ? `?${query}` : ""}`;
    },
    [query],
  );
  return { filters, setFilters, openId: arg, go };
}

/** Only the keys a change names, so setting one filter leaves the others. */
const pick = (f: Partial<Filters>) =>
  Object.fromEntries(
    Object.entries({
      provider: f.provider,
      list: f.view === undefined ? undefined : f.view === "all" ? "all" : "",
      show: f.show,
      q: f.search,
    })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, v || undefined]),
  );

function useRows(now: number) {
  const credentials = useCredentials({ poll: true });
  const quota = useQuota();
  const rows = useMemo(
    () =>
      toRows(
        credentials.data?.files ?? [],
        {
          limits: quota.limits,
          isLive: (a) => {
            const r = quota.reading(a);
            return !!r && "windows" in r;
          },
          hasSource: quota.hasSource,
        },
        now,
      ),
    [credentials.data, quota, now],
  );
  return { credentials, quota, rows };
}

/** Quota sources come from the plugins; when they fail to load, say so where quota is checked. */
function PluginsError() {
  const plugins = usePlugins();
  if (!plugins.isError) return null;
  return (
    <ReadError
      error={plugins.error}
      what={t("accounts.page.pluginsWhat")}
      retry={() => void plugins.refetch()}
    />
  );
}

/** Upload credential JSON files; the field empties again once they are sent. */
function UploadInput({ writes }: { writes: Writes }) {
  const isAvailable = useAvailable();
  return (
    <FileInput
      label={t("accounts.actions.upload")}
      isLabelHidden
      placeholder={t("accounts.actions.upload")}
      accept=".json,application/json"
      isMultiple
      value={[]}
      isLoading={writes.isBusy("upload")}
      isDisabled={!isAvailable(routes.uploadCredentials)}
      onChange={(files) => {
        const list = Array.isArray(files) ? files : files ? [files] : [];
        if (list.length) void writes.upload(list);
      }}
    />
  );
}

type Collected = {
  scope: Row[];
  shown: Row[];
  needs: number;
  checking: boolean;
  checkAll: () => Promise<void>;
};

/** The rows the filters leave, the views' counts, and the quota check of every row. */
function useCollection(
  rows: Row[],
  filters: Filters,
  quota: ReturnType<typeof useQuota>,
): Collected {
  const [checking, setChecking] = useState(false);
  const { provider, show, search, view } = filters;
  const scope = useMemo(
    () => inScope(rows, { provider, show, search }),
    [rows, provider, show, search],
  );
  const shown = useMemo(() => inView(scope, view), [scope, view]);
  const needs = useMemo(() => scope.filter((r) => !r.view.ready).length, [scope]);
  const checkAll = async () => {
    setChecking(true);
    await quota.checkAll(rows.map((r) => r.account));
    setChecking(false);
  };
  return { scope, shown, needs, checking, checkAll };
}

/** The family and status Selectors, each option with how many accounts it keeps. */
function FilterSelectors({
  rows,
  filters,
  setFilters,
}: {
  rows: Row[];
  filters: Filters;
  setFilters: (changes: Partial<Filters>) => void;
}) {
  const families = familiesOf(rows);
  const familyCounts = countBy(rows, families, (r, p) => r.provider === p);
  // Each status as it would narrow the current family and search.
  const unfiltered = inScope(rows, {
    provider: filters.provider,
    show: "",
    search: filters.search,
  });
  const statusCounts = countBy(unfiltered, shows, hasShow);
  return (
    <>
      {/* Drawn with one family too, so the row does not grow once the accounts arrive. */}
      <CountedSelector
        label={t("app.list.family")}
        allLabel={t("app.list.allFamilies")}
        value={filters.provider}
        onChange={(provider) => setFilters({ provider })}
        options={families.map((p) => ({
          value: p,
          label: label(p),
          count: familyCounts.get(p) ?? 0,
        }))}
      />
      <CountedSelector
        label={t("app.list.status")}
        allLabel={t("app.list.anyStatus")}
        value={filters.show}
        onChange={(s) =>
          // Ready and low-quota accounts can serve, so the "needs attention" view would hide them.
          setFilters(
            isShow(s)
              ? { show: s, ...(s === "ready" || s === "low" ? { view: "all" } : {}) }
              : { show: "" },
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

/** The inbox's filter row: views, family, status and search, then the list's own actions. */
function FilterRow({
  rows,
  filters,
  setFilters,
  collected,
  quota,
  writes,
  isStacked,
}: {
  rows: Row[];
  filters: Filters;
  setFilters: (changes: Partial<Filters>) => void;
  collected: Collected;
  quota: ReturnType<typeof useQuota>;
  writes: Writes;
  /** A phone: the views take their own line, so their counts arriving never rewrap the row. */
  isStacked: boolean;
}) {
  const views = (
    <SegmentedControl
      label={t("app.list.view")}
      value={filters.view}
      onChange={(view) => setFilters({ view: view === "all" ? "all" : "needs" })}
    >
      <SegmentedControlItem value="needs" label={t("app.list.needs", { count: collected.needs })} />
      <SegmentedControlItem
        value="all"
        label={t("app.list.all", { count: collected.scope.length })}
      />
    </SegmentedControl>
  );
  return (
    <VStack gap={3}>
      {isStacked && views}
      <HStack gap={3} vAlign="center" wrap="wrap">
        {!isStacked && views}
        <FilterSelectors rows={rows} filters={filters} setFilters={setFilters} />
        <TextInput
          type="search"
          startIcon={<Icon icon={Search} size="sm" />}
          label={t("accounts.filters.search")}
          isLabelHidden
          placeholder={t("accounts.filters.searchHint")}
          value={filters.search}
          onChange={(search) => setFilters(search ? { search, view: "all" } : { search })}
          hasClear
        />
        <StackItem size="fill" />
        <HStack gap={2} vAlign="center">
          <UploadInput writes={writes} />
          <Button
            label={
              collected.checking
                ? t("accounts.actions.checking")
                : t("accounts.actions.checkQuotas")
            }
            icon={<Icon icon={RefreshCw} size="sm" />}
            tooltip={t("accounts.actions.checkQuotasHint")}
            isLoading={collected.checking}
            isDisabled={!rows.some((r) => quota.canCheck(r.account))}
            onClick={() => void collected.checkAll()}
          />
        </HStack>
      </HStack>
    </VStack>
  );
}

/** Why the views leave no rows, and the way back to rows. */
function EmptyView({
  filters,
  setFilters,
}: {
  filters: Filters;
  setFilters: (changes: Partial<Filters>) => void;
}) {
  const filtered = !!(filters.provider || filters.show || filters.search);
  if (!filtered && filters.view === "needs")
    return (
      <EmptyState
        title={t("accounts.empty.allServe")}
        description={t("accounts.empty.allServeDetail")}
        headingLevel={roles.heading.section}
        actions={
          <Button label={t("accounts.empty.showAll")} onClick={() => setFilters({ view: "all" })} />
        }
      />
    );
  return (
    <EmptyState
      title={t("accounts.empty.noMatch")}
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

function NoAccounts({ writes, connect }: { writes: Writes; connect: () => void }) {
  return (
    <EmptyState
      title={t("accounts.empty.title")}
      description={t("accounts.empty.description")}
      headingLevel={roles.heading.section}
      actions={
        <>
          <Button label={t("accounts.page.connect")} variant="primary" onClick={connect} />
          <UploadInput writes={writes} />
        </>
      }
    />
  );
}

type Page = ReturnType<typeof useAccountsPage>;

/** Everything the page reads and keeps, so the frame below only lays it out. */
function useAccountsPage(listShape: ListShape) {
  const { filters, setFilters, openId, go } = useFilters();
  const now = useNow(!!openId);
  const { credentials, quota, rows } = useRows(now);
  const writes = useWrites();
  const connect = useConnectAccount();
  const collected = useCollection(rows, filters, quota);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const open = rows.find((r) => r.id === openId);
  const { isMobile } = useAppShellMobile();
  const shape: ListShape = isMobile ? "stacked" : listShape;
  const onToggle = useCallback((r: Row) => go(r.id === openId ? "" : r.id), [go, openId]);
  const onDeleted = (keys: string[]) => {
    setSelected((s) => new Set([...s].filter((k) => !keys.includes(k))));
    if (open && keys.includes(open.key)) go("");
  };
  return {
    ...{ filters, setFilters, openId, go, now, credentials, quota, rows, writes, connect },
    ...{ collected, selected, setSelected, open, isMobile, shape, onToggle, onDeleted },
  };
}

/** The filter row, or in its place the selection band while rows are ticked. */
function Band({ page }: { page: Page }) {
  const { rows, filters, setFilters, collected, quota, writes, selected, setSelected } = page;
  if (selected.size > 0)
    return (
      <BatchBar
        rows={rows}
        shown={collected.shown}
        tab={filters.provider}
        selected={selected}
        setSelected={setSelected}
        writes={writes}
      />
    );
  // Drawn while the list loads too, so the rows land where the skeleton was.
  if (!rows.length && !page.credentials.isPending) return null;
  return (
    <FilterRow
      {...{ rows, filters, setFilters, collected, quota, writes }}
      isStacked={page.shape === "stacked"}
    />
  );
}

/** The list, its skeleton, or why it is empty. */
function List({ page }: { page: Page }) {
  const { credentials, rows, collected, filters, setFilters, writes, connect } = page;
  if (credentials.isPending) return <LoadingTable shape={page.shape} />;
  if (!credentials.data) return null;
  if (!rows.length) return <NoAccounts writes={writes} connect={connect} />;
  if (!collected.shown.length) return <EmptyView filters={filters} setFilters={setFilters} />;
  return (
    <AccountTable
      shown={collected.shown}
      selected={page.selected}
      setSelected={page.setSelected}
      openId={page.openId}
      onToggle={page.onToggle}
      now={page.now}
      shape={page.shape}
    />
  );
}

export default function Accounts() {
  const [listRef, listShape] = useListShape();
  const page = useAccountsPage(listShape);
  const { credentials, rows, open, go, isMobile } = page;
  const panel = open && {
    label: t("accounts.panel.label", { name: open.name }),
    content: (
      <AccountPanel
        key={open.id}
        row={open}
        rows={rows}
        quota={page.quota}
        writes={page.writes}
        now={page.now}
        onDeleted={page.onDeleted}
        onClose={() => go("")}
      />
    ),
    onClose: () => go(""),
  };
  return (
    <PageFrame
      title={t("accounts.page.title")}
      width="full"
      actions={
        // The empty state carries Connect itself, so the page keeps one primary action.
        (!credentials.data || rows.length > 0) && (
          <Button
            label={t("accounts.page.connect")}
            variant={roles.primaryAction.variant}
            onClick={page.connect}
            icon={<Icon icon={Plus} size="sm" />}
          />
        )
      }
      panel={panel}
      toolbar={!isMobile && <Band page={page} />}
    >
      <MissingActions actions={missing()} />
      {credentials.isError && (
        <ReadError
          error={credentials.error}
          what={t("accounts.page.what")}
          retry={() => void credentials.refetch()}
        />
      )}
      <PluginsError />
      {isMobile && <Band page={page} />}
      <VStack gap={0} ref={listRef}>
        <List page={page} />
      </VStack>
      {page.writes.dialog}
    </PageFrame>
  );
}
