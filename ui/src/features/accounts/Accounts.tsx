// Accounts, from the table-filter template: the filter row above the table, the table grouped by
// provider, the selection toolbar while rows are selected, and the open row in the end panel.
// The template's own LayoutHeader is PageFrame's; its saved views, power search and column and
// grouping options are dropped (PAGE-MAP "Accounts").
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Plus } from "lucide-react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useQuota } from "../../app/QuotaProvider.tsx";
import { useConfig, useCredentials, usePlugins } from "../../app/serverQueries.ts";
import { useHashParams, useHashRoute } from "../../app/useHashRoute.ts";
import { MissingActions } from "../../components/MissingActions.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { routes } from "../../lib/api/routes.ts";
import { readPath } from "../../lib/config-path.ts";
import { t } from "../../lib/i18n.ts";
import { strategy } from "../../lib/routing.ts";
import { AccountPanel } from "./AccountPanel.tsx";
import { AccountTable, LoadingTable } from "./AccountTable.tsx";
import { BatchBar } from "./BatchBar.tsx";
import {
  inTab,
  isShow,
  providerCounts,
  shownRows,
  shows,
  toRows,
  type Filters,
  type Row,
  type Show,
} from "./rows.ts";
import { Toolbar, UploadInput } from "./Toolbar.tsx";
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

/** The filters and the open row, kept in the hash (`#accounts/<id>?provider=codex&show=low&q=`). */
function useFilters() {
  const [params, setParams] = useHashParams();
  const { arg } = useHashRoute();
  const filters: Filters = {
    provider: params.provider ?? "",
    show: isShow(params.show) ? params.show : "",
    search: params.q ?? "",
  };
  const setFilters = (f: Partial<Filters>) => setParams(pick(f));
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
    Object.entries({ provider: f.provider, show: f.show, q: f.search }).filter(
      ([, v]) => v !== undefined,
    ),
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

function SortNote() {
  const config = useConfig();
  if (config.isError)
    return (
      <ReadError
        error={config.error}
        what={t("accounts.page.configWhat")}
        retry={() => void config.refetch()}
      />
    );
  if (!config.data) return null;
  const value: unknown = readPath(config.data, "routing/strategy", "");
  // The dashboard is served only by cliproxy-rs, where an unset strategy is soonest reset.
  const resetFirst = strategy(value, true).value === "soonest-reset";
  return (
    <Text type="supporting" color="secondary">
      {resetFirst ? t("accounts.page.sortResetFirst") : t("accounts.page.sort")}
    </Text>
  );
}

function Empty({ writes }: { writes: Writes }) {
  return (
    <EmptyState
      title={t("accounts.empty.title")}
      description={t("accounts.empty.description")}
      headingLevel={2}
      actions={
        <>
          <Button label={t("accounts.page.connect")} variant="primary" href="#connect" />
          <UploadInput writes={writes} />
        </>
      }
    />
  );
}

type CollectionProps = {
  rows: Row[];
  filters: Filters;
  setFilters: (changes: Partial<Filters>) => void;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  openId: string;
  isPanelBeside: boolean;
  onToggle: (row: Row) => void;
  now: number;
  quota: ReturnType<typeof useQuota>;
  writes: Writes;
};

/** The filter row, the selection toolbar and the table, or why the filters leave no rows. */
function Collection(props: CollectionProps) {
  const { rows, filters, setFilters, quota, writes } = props;
  const [checking, setChecking] = useState(false);
  const { provider, search, show } = filters;
  const tab = useMemo(() => inTab(rows, { provider, search }), [rows, provider, search]);
  const shown = useMemo(() => shownRows(tab, show), [tab, show]);
  const ready = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of shown) if (r.view.ready) m.set(r.provider, (m.get(r.provider) ?? 0) + 1);
    return m;
  }, [shown]);
  const quick = Object.fromEntries(shows.map((s) => [s, tab.filter((r) => r.view[s]).length]));
  const checkAll = async () => {
    setChecking(true);
    await quota.checkAll(rows.map((r) => r.account));
    setChecking(false);
  };
  return (
    <>
      <Toolbar
        filters={filters}
        setFilters={setFilters}
        tabs={providerCounts(rows)}
        total={rows.length}
        quick={quick as Record<Show, number>}
        writes={writes}
        checking={checking}
        canCheck={rows.some((r) => quota.canCheck(r.account))}
        onCheck={() => void checkAll()}
      />
      <PluginsError />
      <SortNote />
      <BatchBar
        rows={rows}
        shown={shown}
        tab={provider}
        selected={props.selected}
        setSelected={props.setSelected}
        writes={writes}
      />
      {shown.length ? (
        <AccountTable {...props} shown={shown} ready={ready} />
      ) : (
        <EmptyState
          title={t("accounts.empty.noMatch")}
          headingLevel={2}
          actions={
            <Button
              label={t("accounts.empty.clear")}
              onClick={() => setFilters({ provider: "", show: "", search: "" })}
            />
          }
        />
      )}
    </>
  );
}

function Meta({ rows }: { rows: Row[] }) {
  return (
    <HStack gap={2} vAlign="center">
      <Badge label={rows.length} />
      <Text type="supporting" color="secondary">
        {t("accounts.page.canServe", { count: rows.filter((r) => r.view.ready).length })}
      </Text>
    </HStack>
  );
}

export default function Accounts() {
  const { filters, setFilters, openId, go } = useFilters();
  const now = useNow(!!openId);
  const { credentials, quota, rows } = useRows(now);
  const writes = useWrites();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const open = rows.find((r) => r.id === openId);
  const { isMobile } = useAppShellMobile();
  const isPanelBeside = !!open && !isMobile;
  const onToggle = useCallback((r: Row) => go(r.id === openId ? "" : r.id), [go, openId]);
  const onDeleted = (keys: string[]) => {
    setSelected((s) => new Set([...s].filter((k) => !keys.includes(k))));
    if (open && keys.includes(open.key)) go("");
  };
  const panel = open && {
    label: t("accounts.panel.label", { name: open.name }),
    content: (
      <AccountPanel
        key={open.id}
        row={open}
        rows={rows}
        quota={quota}
        writes={writes}
        now={now}
        onDeleted={onDeleted}
        onClose={() => go("")}
      />
    ),
    onClose: () => go(""),
  };
  return (
    <PageFrame
      title={t("accounts.page.title")}
      width="full"
      meta={credentials.data && <Meta rows={rows} />}
      actions={
        // The empty state carries Connect itself, so the page keeps one primary action.
        (!credentials.data || rows.length > 0) && (
          <Button
            label={t("accounts.page.connect")}
            variant="primary"
            href="#connect"
            icon={<Icon icon={Plus} size="sm" />}
          />
        )
      }
      panel={panel}
    >
      <MissingActions actions={missing()} />
      {credentials.isError && (
        <ReadError
          error={credentials.error}
          what={t("accounts.page.what")}
          retry={() => void credentials.refetch()}
        />
      )}
      {credentials.isPending && <LoadingTable />}
      {credentials.data && !rows.length && <Empty writes={writes} />}
      {rows.length > 0 && (
        <Collection
          {...{ rows, filters, setFilters, selected, setSelected, openId, onToggle, now, quota }}
          isPanelBeside={isPanelBeside}
          writes={writes}
        />
      )}
      {writes.dialog}
    </PageFrame>
  );
}
