// The key groups on the Accounts list's frame (table-inbox): one flat row per group, its family on
// the second line, every row a doorway to the detail panel (click, Enter or Space; Escape closes
// it; the arrows, Home and End move between rows), the open row one step past hover. The columns
// are Accounts' where they mean the same thing (name, status, requests, at the same widths); the
// keys column takes the room of the quota columns a group lacks. Below the list's stacking width
// (a phone) each row is one summary cell, as on Accounts. A server holds a handful of groups, so
// the list is not windowed.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, type TableColumn, type TablePlugin } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { familyName } from "../../components/keyFamilies.ts";
import { listColumns, type ListShape } from "../../components/listShape.ts";
import { ListSkeleton } from "../../components/loadingRows.tsx";
import { RequestSparkline } from "../../components/RequestSparkline.tsx";
import { isRowItself, onRowKey, rowAt, useReturnFocus } from "../../components/rowKeys.ts";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { TwoLines } from "../../components/TwoLines.tsx";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { entryId, type Entry } from "./groups.ts";
import { endpointParts, MiddleText } from "./MiddleText.tsx";
import { statusOf } from "./words.ts";

const styles = stylex.create({
  clickableRow: { cursor: "pointer" },
  activeRow: {
    backgroundColor: colorVars["--color-overlay-pressed"],
    "--table-row-overlay": colorVars["--color-overlay-pressed"],
  },
});

type Item = Entry & Record<string, unknown>;

/**
 * The family, then a custom endpoint, cut in the middle so its last path segment shows. Only a
 * custom endpoint earns the part after the family: the default would read the same on every row.
 */
function GroupLine({ entry }: { entry: Entry }) {
  const family = familyName(entry.family);
  const url = entry.group["base-url"];
  if (!url)
    return (
      <Text type={roles.textType.supporting} color="secondary" maxLines={1}>
        {family}
      </Text>
    );
  const { head, tail } = endpointParts(url);
  return <MiddleText head={`${family} · ${head}`} tail={tail} isSecondary />;
}

function Name({ entry }: { entry: Entry }) {
  return (
    <Text type={roles.textType.body} maxLines={1}>
      {entry.name}
    </Text>
  );
}

function Lamp({ entry }: { entry: Entry }) {
  const s = statusOf(entry);
  return <StatusLamp status={s.status} label={s.label} />;
}

const keyCount = (entry: Entry) => t("providers.table.keys", { count: entry.keys.length });

function Requests({ entry, pending }: { entry: Entry; pending: boolean }) {
  if (pending)
    return <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />;
  if (!entry.traffic)
    return (
      <Text type={roles.textType.supporting} color="secondary">
        {t("app.quota.notReported")}
      </Text>
    );
  return <RequestSparkline buckets={entry.traffic} times={entry.traffic.times} />;
}

/** The phone's summary row: the name and family, then the status, then the keys. */
function Summary({ entry }: { entry: Entry }) {
  return (
    <VStack gap={0.5}>
      <Name entry={entry} />
      <GroupLine entry={entry} />
      <Lamp entry={entry} />
      <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
        {keyCount(entry)}
      </Text>
    </VStack>
  );
}

type TableProps = {
  shown: Entry[];
  openId: string;
  onOpen: (entry: Entry) => void;
  trafficPending: boolean;
  shape: ListShape;
};

const headers = {
  group: () => t("providers.table.group"),
  status: () => t("providers.table.status"),
  keys: () => t("providers.table.key"),
  requests: () => t("providers.table.requests"),
};

/** Each column's width for a shape, the same for the list and its skeleton. */
function widthsOf(shape: ListShape) {
  if (shape === "stacked") return { group: listColumns.stacked };
  const widths = {
    group: listColumns.name,
    status: listColumns.status,
    keys: shape === "wide" ? listColumns.keys.wide : listColumns.keys.tight,
  };
  return shape === "wide" ? { ...widths, requests: listColumns.requests } : widths;
}

function columnsOf({ shape, trafficPending }: TableProps): TableColumn<Item>[] {
  const cells: Record<keyof typeof headers, (e: Entry) => ReactNode> = {
    group: (e) =>
      shape === "stacked" ? (
        <Summary entry={e} />
      ) : (
        <TwoLines first={<Name entry={e} />} second={<GroupLine entry={e} />} />
      ),
    // No group reason exists beyond its status word, so the second line stays empty.
    status: (e) => <TwoLines first={<Lamp entry={e} />} second="" />,
    keys: (e) => (
      <Text type={roles.textType.body} hasTabularNumbers>
        {keyCount(e)}
      </Text>
    ),
    requests: (e) => <Requests entry={e} pending={trafficPending} />,
  };
  return Object.entries(widthsOf(shape)).map(([key, width]) => {
    const k = key as keyof typeof headers;
    return { key: k, width, header: headers[k](), renderCell: (e: Item) => cells[k](e) };
  });
}

function useRowPlugin(
  { openId, onOpen }: TableProps,
  indexOf: Map<Entry, number>,
  moveTo: (index: number) => void,
) {
  return useMemo<TablePlugin<Item>>(
    () => ({
      transformBodyRow: (props, item) => {
        const id = entryId(item);
        const isOpen = id === openId;
        return {
          ...props,
          htmlProps: {
            ...props.htmlProps,
            "data-index": indexOf.get(item) ?? 0,
            "data-group": id,
            tabIndex: 0,
            "aria-current": isOpen ? true : undefined,
            onClick: (event) => {
              if (isRowItself(event.target)) onOpen(item);
            },
            onKeyDown: (event) =>
              onRowKey(
                event,
                { index: indexOf.get(item) ?? 0, isOpen, toggle: () => onOpen(item) },
                moveTo,
              ),
          },
          xstyle: props.xstyle.concat(
            isOpen ? [styles.clickableRow, styles.activeRow] : styles.clickableRow,
          ),
        };
      },
    }),
    [openId, onOpen, indexOf, moveTo],
  );
}

export function ProviderTable(props: TableProps) {
  const { shown, openId } = props;
  const [holder, setHolder] = useState<HTMLElement | null>(null);
  const indexOf = useMemo(() => new Map(shown.map((e, i) => [e, i])), [shown]);
  const moveTo = useCallback(
    (index: number) => rowAt(holder, Math.max(0, Math.min(shown.length - 1, index)))?.focus(),
    [holder, shown.length],
  );
  const reveal = useCallback((id: string) => shown.some((e) => entryId(e) === id), [shown]);
  const rowOf = useCallback(
    (id: string) =>
      holder?.querySelector<HTMLElement>(`tbody tr[data-group="${CSS.escape(id)}"]`) ?? null,
    [holder],
  );
  useReturnFocus(openId, reveal, rowOf);
  const plugin = useRowPlugin(props, indexOf, moveTo);
  const plugins = useMemo(() => ({ rows: plugin }), [plugin]);
  return (
    <VStack gap={0} ref={setHolder}>
      <Table<Item>
        data={shown}
        columns={columnsOf(props)}
        idKey={(e) => entryId(e)}
        density={roles.table.density}
        dividers="rows"
        hasHover
        verticalAlign="top"
        plugins={plugins}
      />
    </VStack>
  );
}

/** The list's shape while the config loads: its columns over the shared skeleton rows. */
export function ProviderTableSkeleton({ shape }: { shape: ListShape }) {
  const columns = Object.entries(widthsOf(shape)).map(([key, width]) => ({
    key,
    width,
    header: headers[key as keyof typeof headers](),
  }));
  return <ListSkeleton label={t("providers.page.loading")} columns={columns} />;
}
