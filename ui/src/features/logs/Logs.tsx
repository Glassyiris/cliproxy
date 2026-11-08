// Logs, the Activity route's second tab (`?view=logs`), from the Astryx template table-filter on
// the shared PageFrame. Deviations from the template, one per line with its reason:
// - The header is PageFrame's: the view's title, the controls at the end,
//   then the filter row; padded by the page roles, not the template's 0/16.
// - The line count ends the filter row, not the header line.
// - The filter row stays in the header on a phone too, so the search is in view while following the
//   end of the log.
// - No saved views, power search, bulk edit, view options or density switch: a log has no saved
//   state or columns to choose, and roles "Table density" removes the switch.
// - The filter chips are a log choice (SegmentedControl: application log or error logs, the
//   page's own tabs) and, for the application log, a level Selector and the management
//   calls switch; they all fit one row, so there is no overflow list.
// - Header controls are default size (36), not the template's sm: roles "Primary action" keeps
//   every header control at one height.
// - The header has no primary action: Follow is a toggle and Clear is destructive, so Clear goes
//   into the More menu and asks first.
// - Rows are virtualized (LogRows.tsx) instead of the template's batches; the open request's log
//   is the end panel (a bottom sheet on phones) with the raw text in a CodeBlock, not a
//   MetadataList, because the server returns the log as text.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useAction } from "../../app/useAction.ts";
import { useHashParams, useHashRoute } from "../../app/useHashRoute.ts";
import { MissingActions, useAvailable } from "../../components/MissingActions.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { clearLogs } from "../../lib/api/logs.ts";
import { routes } from "../../lib/api/routes.ts";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { ErrorLogs } from "./ErrorLogs.tsx";
import { filesMatching, shownLines, type LevelFilter, type LogLine } from "./lines.ts";
import { LoadingRows, LogRows } from "./LogRows.tsx";
import { logKeys, useErrorLogs, useLogTail } from "./queries.ts";
import { RequestLog } from "./RequestLog.tsx";
import { MoreMenu, requestIdOf, Toolbar, type Filters, type LogSource } from "./Toolbar.tsx";

/**
 * The log choice, the level, the management calls switch and the open request, kept in the hash
 * (`#activity/<id>?view=logs&log=errors&level=error&management=1`), and the search text, kept in
 * memory: a pasted key fragment would land in the browser history, so a `q` left in the hash by
 * an older link is dropped, and the earlier page's `tab=errors` becomes `log=errors`.
 */
function useLogsView() {
  const [params, setParams] = useHashParams();
  const { arg } = useHashRoute();
  const [filter, setFilter] = useState("");
  const isOld = params.q !== undefined || params.tab !== undefined;
  useEffect(() => {
    if (isOld)
      setParams(
        { q: undefined, tab: undefined, log: params.tab === "errors" ? "errors" : params.log },
        "replace",
      );
  });
  const query = new URLSearchParams(params).toString();
  const suffix = query ? `?${query}` : "";
  const level: LevelFilter =
    params.level === "warn" || params.level === "error" ? params.level : "";
  const source: LogSource = params.log === "errors" || params.tab === "errors" ? "errors" : "app";
  return {
    source,
    setSource: (source: LogSource) =>
      setParams({ log: source === "errors" ? source : undefined }, "push"),
    filters: { filter, withManagement: params.management === "1", level },
    setFilters: (f: Partial<Filters>) => {
      if (f.filter !== undefined) setFilter(f.filter);
      if (f.withManagement !== undefined || f.level !== undefined)
        setParams(
          {
            ...(f.withManagement !== undefined && {
              management: f.withManagement ? "1" : undefined,
            }),
            ...(f.level !== undefined && { level: f.level || undefined }),
          },
          "replace",
        );
    },
    openId: arg,
    suffix,
    go: (id: string) => {
      location.hash = `#activity${id ? `/${encodeURIComponent(id)}` : ""}${suffix}`;
    },
  };
}

type View = ReturnType<typeof useLogsView>;
type Tail = ReturnType<typeof useLogTail>;

/** On only while the application log is shown and its last read succeeded. */
function FollowButton({
  isFollowing,
  tail,
  onChange,
}: {
  isFollowing: boolean;
  tail: Tail;
  onChange: () => void;
}) {
  const isAvailable = useAvailable();
  const canFollow = isAvailable(routes.readLogs);
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

/** The application log: the lines, or why there are none. */
function ApplicationLog({
  tail,
  shown,
  view,
  search,
}: {
  tail: Tail;
  shown: LogLine[] | undefined;
  view: View;
  search: () => void;
}) {
  const kept = tail.data?.lines.length;
  const readError = (
    <ReadError error={tail.error} what={t("logs.lines.what")} retry={() => void tail.refetch()} />
  );
  const id = requestIdOf(view.filters.filter);
  const showAll = () => {
    view.setFilters({ filter: "", withManagement: true, level: "" });
    // The button goes with the empty state; the search it cleared takes focus.
    search();
  };
  return (
    <>
      {tail.isError && kept === undefined && readError}
      {tail.isPending && !tail.isError && <LoadingRows isPanelOpen={!!view.openId} />}
      {kept === 0 && (
        <EmptyState
          title={t("logs.empty.title")}
          description={t("logs.empty.description", {
            setting: "observability.logs.logging-to-file",
          })}
          headingLevel={roles.heading.section}
        />
      )}
      {!!kept && shown?.length === 0 && (
        <EmptyState
          icon={<Icon icon="search" size="lg" />}
          title={t("logs.empty.noMatch")}
          headingLevel={roles.heading.section}
          actions={
            <HStack gap={3} wrap="wrap" hAlign="center">
              <Button label={t("logs.empty.showAll")} onClick={showAll} />
              {id && (
                <Button
                  label={t("logs.request.openId", { id })}
                  variant="secondary"
                  onClick={() => view.go(id)}
                />
              )}
            </HStack>
          }
        />
      )}
      {!!shown?.length && <LogRows lines={shown} query={view.suffix} isPanelOpen={!!view.openId} />}
      {/* A failed poll keeps the lines it had; its banner sits after them, where following
          keeps the view. */}
      {tail.isError && kept !== undefined && readError}
    </>
  );
}

/** The More menu, with the clear that resets the tail and rereads what depends on it. */
function Menu({ toolbar }: { toolbar: RefObject<HTMLDivElement | null> }) {
  const client = useQueryClient();
  const action = useAction();
  const isAvailable = useAvailable();
  const canClear = isAvailable(routes.clearLogs) && isAvailable(routes.readLogs);
  const onClear = async () => {
    await clearLogs();
    void client.resetQueries({ queryKey: logKeys.tail });
    void client.invalidateQueries({ queryKey: logKeys.requests });
    void client.invalidateQueries({ queryKey: logKeys.errors });
  };
  return <MoreMenu action={action} canClear={canClear} onClear={onClear} searchRow={toolbar} />;
}

/**
 * The chosen log's rows: the application log's lines or the error log files, each filtered, and
 * their counts for the filter row, given only for a list whose last read succeeded.
 */
function useShown(view: View, isFollowing: boolean) {
  const isApp = view.source === "app";
  const tail = useLogTail(isFollowing, isApp);
  const lines = tail.data?.lines;
  const { filter, withManagement, level } = view.filters;
  const shown = useMemo(
    () => lines && shownLines(lines, filter, withManagement, level),
    [lines, filter, withManagement, level],
  );
  const files = useErrorLogs(!isApp);
  const matching = useMemo(
    () => files.data && filesMatching(files.data, filter),
    [files.data, filter],
  );
  const [list, read] = isApp ? [shown, lines] : [matching, files.data];
  const failed = isApp ? tail.isError : files.isError;
  const counts = list && read && !failed ? { shown: list.length, kept: read.length } : null;
  return { tail, shown, files, matching, counts };
}

/** The open request's panel, and opening one by ID (again: reread it). */
function useRequestPanel(view: View, search: () => void) {
  const client = useQueryClient();
  const close = () => {
    view.go("");
    // The close button goes with the panel; the search takes focus.
    search();
  };
  return {
    onOpen: (id: string) => {
      if (id === view.openId) void client.invalidateQueries({ queryKey: logKeys.request(id) });
      else view.go(id);
    },
    panel: view.openId
      ? {
          label: t("logs.request.panel", { id: view.openId }),
          content: <RequestLog key={view.openId} id={view.openId} onClose={close} />,
          onClose: close,
        }
      : undefined,
  };
}

export default function Logs() {
  const view = useLogsView();
  const [isFollowing, setIsFollowing] = useState(true);
  const isApp = view.source === "app";
  const { tail, shown, files, matching, counts } = useShown(view, isFollowing);
  const toolbar = useRef<HTMLDivElement>(null);
  const search = () => toolbar.current?.querySelector("input")?.focus();
  const { onOpen, panel } = useRequestPanel(view, search);
  const filterRow = (
    <Toolbar
      ref={toolbar}
      source={view.source}
      setSource={view.setSource}
      filters={view.filters}
      setFilters={view.setFilters}
      onOpen={onOpen}
      count={
        counts && (
          <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
            {isApp ? t("logs.page.meta", counts) : t("logs.page.files", counts)}
          </Text>
        )
      }
    />
  );
  return (
    <PageFrame
      title={t("logs.page.title")}
      width="full"
      actions={
        // One group, so on a phone the menu does not wrap away from Follow.
        <HStack gap={3} vAlign="center">
          {isApp && (
            <FollowButton
              isFollowing={isFollowing}
              tail={tail}
              onChange={() => setIsFollowing((f) => !f)}
            />
          )}
          <Menu toolbar={toolbar} />
        </HStack>
      }
      panel={panel}
      toolbar={filterRow}
    >
      <MissingActions actions={[{ route: routes.clearLogs, label: t("logs.clear.button") }]} />
      {isApp ? (
        <ApplicationLog {...{ tail, shown, view, search }} />
      ) : (
        <ErrorLogs
          files={files}
          shown={matching}
          onShowAll={() => {
            view.setFilters({ filter: "" });
            search();
          }}
        />
      )}
    </PageFrame>
  );
}
