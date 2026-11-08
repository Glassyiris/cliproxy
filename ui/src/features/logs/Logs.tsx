// Logs, from the table-filter template: the filter row above the log lines and the open request's
// log in the end panel. The template's own LayoutHeader is PageFrame's; its saved views, power
// search and column options are dropped (PAGE-MAP "Logs").
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useAction, type Action } from "../../app/useAction.ts";
import { useHashParams, useHashRoute } from "../../app/useHashRoute.ts";
import { MissingActions, useAvailable } from "../../components/MissingActions.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { clearLogs } from "../../lib/api/logs.ts";
import { routes } from "../../lib/api/routes.ts";
import { t } from "../../lib/i18n.ts";
import { ErrorLogs } from "./ErrorLogs.tsx";
import { shownLines, type LogLine } from "./lines.ts";
import { LoadingRows, LogRows } from "./LogRows.tsx";
import { logKeys, useLogTail } from "./queries.ts";
import { RequestLog } from "./RequestLog.tsx";
import { Toolbar, type Filters } from "./Toolbar.tsx";

const PANEL_ID = "logs-tab-panel";

/**
 * The tab, the management calls switch and the open request, kept in the hash
 * (`#logs/<id>?tab=errors&management=1`), and the filter text, kept in memory: a pasted key
 * fragment would land in the browser history, so a `q` left in the hash by an older link is
 * dropped.
 */
function useLogsView() {
  const [params, setParams] = useHashParams();
  const { arg } = useHashRoute();
  const [filter, setFilter] = useState("");
  const hasOldFilter = params.q !== undefined;
  useEffect(() => {
    if (hasOldFilter) setParams({ q: undefined }, "replace");
  });
  const query = new URLSearchParams(params).toString();
  const suffix = query ? `?${query}` : "";
  return {
    tab: params.tab === "errors" ? "errors" : "app",
    setTab: (tab: string) => setParams({ tab: tab === "errors" ? tab : undefined }, "push"),
    filters: { filter, withManagement: params.management === "1" },
    setFilters: (f: Partial<Filters>) => {
      if (f.filter !== undefined) setFilter(f.filter);
      if (f.withManagement !== undefined)
        setParams({ management: f.withManagement ? "1" : undefined }, "replace");
    },
    openId: arg,
    suffix,
    go: (id: string) => {
      location.hash = `#logs${id ? `/${encodeURIComponent(id)}` : ""}${suffix}`;
    },
  };
}

type Tail = ReturnType<typeof useLogTail>;

/** On only while the application log is shown and its last read succeeded. */
function FollowButton({
  isFollowing,
  isShown,
  tail,
  onChange,
}: {
  isFollowing: boolean;
  isShown: boolean;
  tail: Tail;
  onChange: () => void;
}) {
  const isAvailable = useAvailable();
  const canFollow = isAvailable(routes.readLogs) && isShown;
  const isOn = isFollowing && canFollow;
  const isFailing = isOn && tail.isError;
  const label = isFailing
    ? t("logs.follow.failed")
    : isOn
      ? t("logs.follow.on")
      : t("logs.follow.off");
  const status = isFailing ? "failing" : isOn ? "ready" : "disabled";
  return (
    <ToggleButton
      label={label}
      isPressed={isOn}
      isDisabled={!canFollow}
      icon={
        <StatusLamp status={status} label={label} isPulsing={isOn && !isFailing} isLabelHidden />
      }
      onPressedChange={onChange}
    />
  );
}

/** The Application log tab's filter row, kept in the page header while the lines scroll. */
function AppToolbar({
  hash,
  action,
  toolbar,
}: {
  hash: ReturnType<typeof useLogsView>;
  action: Action;
  toolbar: RefObject<HTMLDivElement | null>;
}) {
  const client = useQueryClient();
  const isAvailable = useAvailable();
  const canClear = isAvailable(routes.clearLogs) && isAvailable(routes.readLogs);
  const onClear = async () => {
    await clearLogs();
    void client.resetQueries({ queryKey: logKeys.tail });
    void client.invalidateQueries({ queryKey: logKeys.requests });
    void client.invalidateQueries({ queryKey: logKeys.errors });
  };
  const onOpen = (id: string) => {
    if (id === hash.openId) void client.invalidateQueries({ queryKey: logKeys.request(id) });
    else hash.go(id);
  };
  return (
    <Toolbar
      ref={toolbar}
      filters={hash.filters}
      setFilters={hash.setFilters}
      action={action}
      canClear={canClear}
      onClear={onClear}
      openId={hash.openId}
      onOpen={onOpen}
    />
  );
}

/** The Application log tab: the lines or why there are none, after the filter row on a phone. */
function ApplicationLog({
  tail,
  shown,
  hash,
  toolbar,
  filterRow,
}: {
  tail: Tail;
  shown: LogLine[] | undefined;
  hash: ReturnType<typeof useLogsView>;
  toolbar: RefObject<HTMLDivElement | null>;
  filterRow: ReactNode;
}) {
  const kept = tail.data?.lines.length;
  const readError = (
    <ReadError error={tail.error} what={t("logs.lines.what")} retry={() => void tail.refetch()} />
  );
  const showAll = () => {
    hash.setFilters({ filter: "", withManagement: true });
    // The button goes with the empty state; the filter it cleared takes focus.
    toolbar.current?.querySelector("input")?.focus();
  };
  return (
    <>
      <MissingActions actions={[{ route: routes.clearLogs, label: t("logs.clear.button") }]} />
      {filterRow}
      {tail.isError && kept === undefined && readError}
      {tail.isPending && !tail.isError && <LoadingRows isPanelOpen={!!hash.openId} />}
      {kept === 0 && (
        <EmptyState
          title={t("logs.empty.title")}
          description={t("logs.empty.description", {
            setting: "observability.logs.logging-to-file",
          })}
          headingLevel={2}
        />
      )}
      {!!kept && shown?.length === 0 && (
        <EmptyState
          icon={<Icon icon="search" size="lg" />}
          title={t("logs.empty.noMatch")}
          headingLevel={2}
          actions={<Button label={t("logs.empty.showAll")} onClick={showAll} />}
        />
      )}
      {!!shown?.length && <LogRows lines={shown} query={hash.suffix} isPanelOpen={!!hash.openId} />}
      {/* A failed poll keeps the lines it had; its banner sits after them, where following
          keeps the view. */}
      {tail.isError && kept !== undefined && readError}
    </>
  );
}

function LogTabs({
  hash,
  tabs,
}: {
  hash: ReturnType<typeof useLogsView>;
  tabs: RefObject<HTMLElement | null>;
}) {
  return (
    <TabList ref={tabs} value={hash.tab} onChange={hash.setTab} role="tablist" hasDivider>
      <Tab value="app" label={t("logs.tabs.app")} panelId={PANEL_ID} />
      <Tab value="errors" label={t("logs.tabs.errors")} panelId={PANEL_ID} />
    </TabList>
  );
}

export default function Logs() {
  const hash = useLogsView();
  const [isFollowing, setIsFollowing] = useState(true);
  const action = useAction();
  const tail = useLogTail(isFollowing, hash.tab === "app");
  const lines = tail.data?.lines;
  const { filter, withManagement } = hash.filters;
  const shown = useMemo(
    () => lines && shownLines(lines, filter, withManagement),
    [lines, filter, withManagement],
  );
  const toolbar = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLElement>(null);
  const { isMobile } = useAppShellMobile();
  const { openId } = hash;
  const close = () => {
    hash.go("");
    // The close button goes with the panel; the request ID field takes focus, or on the Error
    // logs tab, where there is none, the tab.
    const next =
      toolbar.current?.querySelector<HTMLElement>("input[type=text]") ??
      tabs.current?.querySelector<HTMLElement>("[role=tab][aria-selected=true]");
    next?.focus();
  };
  const tabList = <LogTabs hash={hash} tabs={tabs} />;
  const filterRow = hash.tab === "app" && (
    <AppToolbar hash={hash} action={action} toolbar={toolbar} />
  );
  const panel = openId
    ? {
        label: t("logs.request.panel", { id: openId }),
        content: <RequestLog key={openId} id={openId} onClose={close} />,
        onClose: close,
      }
    : undefined;
  return (
    <PageFrame
      title={t("logs.page.title")}
      width="full"
      meta={
        // Counts only for a tail whose last read succeeded.
        hash.tab === "app" &&
        lines &&
        shown &&
        !tail.isError && (
          <Text type="supporting" color="secondary" hasTabularNumbers>
            {t("logs.page.meta", { shown: shown.length, kept: lines.length })}
          </Text>
        )
      }
      actions={
        <FollowButton
          isFollowing={isFollowing}
          isShown={hash.tab === "app"}
          tail={tail}
          onChange={() => setIsFollowing((f) => !f)}
        />
      }
      panel={panel}
      // On a phone the header would take most of the screen, so the rows stay in the content.
      toolbar={
        !isMobile && (
          <VStack gap={4}>
            {tabList}
            {filterRow}
          </VStack>
        )
      }
    >
      {isMobile && tabList}
      <VStack gap={4} id={PANEL_ID} role="tabpanel">
        {hash.tab === "errors" ? (
          <ErrorLogs />
        ) : (
          <ApplicationLog {...{ tail, shown, hash, toolbar }} filterRow={isMobile && filterRow} />
        )}
      </VStack>
    </PageFrame>
  );
}
