// The account table of the table-filter template: Astryx Table with its grouped rows, the
// template's row activation, and the selection checkbox in the first column as the
// TableLeadingMarkSelection block places it. Astryx Table has no virtualizer, so its body rows
// are windowed with @tanstack/react-virtual: the table gets only the rows in view, between two
// spacer rows as tall as the rows left out, and keeps one fixed column layout. Every column sits on
// Table's default column floor, so on a phone the table scrolls in its own region instead of
// squeezing; the account column takes one and a half shares, the most that still fits the floors
// of all six beside the open panel at its default width.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import * as stylex from "@stylexjs/stylex";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import {
  Table,
  TableCell,
  proportional,
  useTableGroupedRows,
  useTableSelectionState,
  type TableColumn,
  type TablePlugin,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { QuotaWindow } from "../../components/QuotaWindow.tsx";
import { lampStatus, StatusLamp } from "../../components/StatusLamp.tsx";
import { TrafficStrip } from "../../components/TrafficStrip.tsx";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import type { Row } from "./rows.ts";
import { ageOf, lastOf, subOf, wordOf } from "./words.ts";

const styles = stylex.create({
  // From the template: a row opens the panel, and the open row is one step past hover.
  clickableRow: { cursor: "pointer" },
  activeRow: {
    backgroundColor: colorVars["--color-overlay-pressed"],
    "--table-row-overlay": colorVars["--color-overlay-pressed"],
  },
  spacer: (height: number) => ({ height, paddingBlock: 0 }),
});

// A first guess for a row's height; each rendered row is measured, so it only steers the
// scrollbar until then. Rows are two lines in every column.
const ROW_ESTIMATE = 64;
const OVERSCAN = 8;

/** A spacer stands for the rows above or below the window; it has no account. */
type Spacer = { spacer: number; key: string };
// Group header rows answer "" for any field they lack, so only a number marks a spacer.
const spacerOf = (item: Row) => {
  const height = (item as unknown as Partial<Spacer>).spacer;
  return typeof height === "number" ? height : undefined;
};
const isAccount = (item: Row) => !!item.account && spacerOf(item) === undefined;

/**
 * Where the table body starts in the scrolled content. Banners and the batch bar above it come
 * and go, and each changes the content's height, so it is measured again on every resize.
 */
function useScrollMargin(scroller: HTMLElement | null, body: HTMLElement | null) {
  const [margin, setMargin] = useState(0);
  useEffect(() => {
    if (!scroller || !body) return;
    const measure = () => {
      const top =
        body.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      setMargin((m) => (Math.abs(top - m) > 0.5 ? top : m));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const child of scroller.children) observer.observe(child);
    return () => observer.disconnect();
  }, [scroller, body]);
  return margin;
}

/** The nearest ancestor that scrolls vertically: the page's content region. */
function scrollParent(el: HTMLElement | null) {
  for (let p = el?.parentElement; p; p = p.parentElement)
    if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  return null;
}

export type TableProps = {
  shown: Row[];
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  openId: string;
  onToggle: (row: Row) => void;
  now: number;
  /** Accounts that can serve, per provider, for the group rows. */
  ready: Map<string, number>;
  /** The open account's panel sits beside the table (not a bottom sheet). */
  isPanelBeside: boolean;
};

type Selection = ReturnType<typeof useTableSelectionState<Row>>["selectionConfig"];

function StatusCell({ row, selection, now }: { row: Row; selection: Selection; now: number }) {
  return (
    <HStack gap={2} vAlign="start">
      <CheckboxInput
        label={t("accounts.table.select", { name: row.name })}
        isLabelHidden
        value={selection.getIsItemSelected(row)}
        onChange={(checked) => selection.onSelectItem({ item: row, isSelected: checked })}
      />
      <VStack gap={0.5}>
        <StatusLamp status={lampStatus[row.view.lamp]} label={wordOf(row.view, now)} />
        <Text type="supporting" color="secondary" maxLines={2}>
          {subOf(row.view)}
        </Text>
      </VStack>
    </HStack>
  );
}

/** A cell of two lines: the value, and a secondary line under it. */
function TwoLines({ first, second }: { first: string; second: string }) {
  return (
    <VStack gap={0.5}>
      <Text type="body" maxLines={1} hasTabularNumbers>
        {first}
      </Text>
      <Text type="supporting" color="secondary" maxLines={1} hasTabularNumbers>
        {second}
      </Text>
    </VStack>
  );
}

/**
 * The fixed column set. Beside the panel only Status, Account, Session and Weekly remain: six
 * columns on Table's default floor leave no header or cell its whole text in the width the panel
 * leaves, and the panel's facts cover the account in detail.
 */
function columnsOf(
  selection: Selection,
  all: boolean,
  max: number,
  now: number,
  isPanelBeside: boolean,
): TableColumn<Row>[] {
  const cell = (render: (r: Row) => ReactNode) => (r: Row) => (isAccount(r) ? render(r) : null);
  const columns: TableColumn<Row>[] = [
    {
      key: "status",
      width: proportional(1),
      header: (
        <HStack gap={2} vAlign="center">
          <CheckboxInput
            label={t("accounts.table.selectShown")}
            isLabelHidden
            value={all ? true : selection.getIsIndeterminate?.() ? "indeterminate" : false}
            onChange={(checked) => selection.onSelectAll({ isAllSelected: checked })}
          />
          {t("accounts.columns.status")}
        </HStack>
      ),
      renderCell: cell((r) => <StatusCell row={r} selection={selection} now={now} />),
    },
    {
      key: "account",
      header: t("accounts.columns.account"),
      width: proportional(1.5),
      renderCell: cell((r) => (
        <TwoLines
          first={r.name}
          second={
            [r.account.id_token?.plan_type, r.account.note].filter(Boolean).join(" · ") ||
            r.account.name
          }
        />
      )),
    },
    ...(["session", "weekly"] as const).map((k) => ({
      key: k,
      width: proportional(1),
      header: k === "session" ? t("accounts.columns.session") : t("accounts.columns.weekly"),
      renderCell: cell((r) => <QuotaWindow bar={r.view[k]} now={now} isCompact />),
    })),
  ];
  if (isPanelBeside) return columns;
  return [
    ...columns,
    {
      key: "requests",
      width: proportional(1.5),
      header: t("accounts.columns.requests"),
      renderCell: cell((r) =>
        r.buckets ? (
          <TrafficStrip buckets={r.buckets} max={max} />
        ) : (
          <Text type="supporting" color="secondary">
            {t("app.quota.notReported")}
          </Text>
        ),
      ),
    },
    {
      key: "lastUsed",
      width: proportional(1),
      header: t("accounts.columns.lastUsed"),
      renderCell: cell((r) => <TwoLines first={lastOf(r.view)} second={ageOf(r.view, now)} />),
    },
  ];
}

function useColumns({ shown, selected, setSelected, now, isPanelBeside }: TableProps) {
  const { selectionConfig } = useTableSelectionState<Row>({
    data: shown,
    idKey: "key",
    selectedKeys: selected,
    setSelectedKeys: setSelected,
  });
  // The busiest bucket of the whole list, so strips side by side compare.
  const max = useMemo(() => Math.max(1, ...shown.flatMap((r) => r.buckets?.total ?? [])), [shown]);
  const all = selectionConfig.getIsAllSelected();
  return useMemo(
    () => columnsOf(selectionConfig, all, max, now, isPanelBeside),
    [selectionConfig, all, max, now, isPanelBeside],
  );
}

/** Where the arrow keys move from the row at `index`, or null for any other key. */
function moveOf(key: string, index: number, count: number) {
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

type Roving = {
  active: number;
  count: number;
  /** Marks the row active, as focus landing in it does. */
  activate: (index: number) => void;
  /** Scrolls the row into the window and focuses it. */
  moveTo: (index: number) => void;
};

/**
 * The template's row activation, what the virtualizer needs to measure each row, and the roving
 * focus: only the active row is in the tab order, and the arrow keys, Home and End move it.
 */
function useRowPlugin(
  { openId, onToggle }: TableProps,
  measure: (el: HTMLTableRowElement | null) => void,
  indexOf: Map<Row, number>,
  { active, count, activate, moveTo }: Roving,
) {
  return useMemo<TablePlugin<Row>>(
    () => ({
      transformBodyRow: (props, item) => {
        const height = spacerOf(item);
        if (height !== undefined)
          return {
            ...props,
            htmlProps: { ...props.htmlProps, "aria-hidden": true },
            children: <TableCell colSpan={999} xstyle={styles.spacer(height)} />,
          };
        const index = indexOf.get(item) ?? 0;
        const measured = {
          ...props,
          ref: measure,
          htmlProps: {
            ...props.htmlProps,
            "data-index": index,
            tabIndex: index === active ? 0 : -1,
            onFocus: () => {
              if (index !== active) activate(index);
            },
            onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
              if (event.target !== event.currentTarget) return;
              const next = moveOf(event.key, index, count);
              if (next === null) return;
              event.preventDefault();
              moveTo(next);
            },
          },
        };
        if (!isAccount(item)) return measured;
        const isOpen = item.id === openId;
        return {
          ...measured,
          htmlProps: {
            ...measured.htmlProps,
            "aria-current": isOpen ? true : undefined,
            onClick: (event) => {
              // Checkboxes and other cell controls own their own clicks.
              if ((event.target as HTMLElement).closest("input, button, a, label")) return;
              onToggle(item);
            },
            onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
              // Only when the row itself has focus, so a checkbox keeps Space.
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onToggle(item);
              } else measured.htmlProps.onKeyDown(event);
            },
          },
          xstyle: props.xstyle.concat(
            isOpen ? [styles.clickableRow, styles.activeRow] : styles.clickableRow,
          ),
        };
      },
    }),
    [openId, onToggle, measure, indexOf, active, count, activate, moveTo],
  );
}

/**
 * The roving focus over the windowed rows. Moving scrolls the row into the window first, then
 * focuses it once it is rendered. Controls inside other rows leave the tab order, so Tab enters
 * and leaves the table once. Closing the panel brings focus back to the row that opened it.
 */
function useRoving(
  items: Row[],
  keyOf: (row: Row) => string,
  holder: HTMLElement | null,
  scrollToIndex: (index: number) => void,
  openId: string,
): Roving {
  // By key, since every poll and clock tick builds new row objects.
  const [activeKey, setActiveKey] = useState("");
  const active = Math.max(
    0,
    items.findIndex((r) => keyOf(r) === activeKey),
  );
  const rowAt = useCallback(
    (index: number) => holder?.querySelector<HTMLElement>(`tbody tr[data-index="${index}"]`),
    [holder],
  );
  const activate = useCallback(
    (index: number) => setActiveKey(items[index] ? keyOf(items[index]) : ""),
    [items, keyOf],
  );
  const moveTo = useCallback(
    (index: number) => {
      activate(index);
      const rendered = rowAt(index);
      // A rendered row takes focus at once, so a held arrow key never acts twice from one row.
      if (rendered) return rendered.focus();
      scrollToIndex(index);
      let tries = 60;
      const focus = () => {
        const row = rowAt(index);
        if (row) row.focus();
        else if (tries-- > 0) requestAnimationFrame(focus);
      };
      requestAnimationFrame(focus);
    },
    [activate, rowAt, scrollToIndex],
  );
  useLayoutEffect(() => {
    for (const control of holder?.querySelectorAll<HTMLElement>(
      "tbody tr[data-index] :is(input, button, a)",
    ) ?? [])
      control.tabIndex = control.closest("tr")?.dataset.index === String(active) ? 0 : -1;
  });
  const opened = useRef(openId);
  useEffect(() => {
    const was = opened.current;
    opened.current = openId;
    if (!was || openId) return;
    const index = items.findIndex((r) => isAccount(r) && r.id === was);
    if (index >= 0) moveTo(index);
  }, [openId, items, moveTo]);
  return { active, count: items.length, activate, moveTo };
}

export function AccountTable(props: TableProps) {
  const { shown, ready } = props;
  const columns = useColumns(props);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const grouped = useTableGroupedRows<Row>({
    data: shown,
    groupBy: (r) => r.provider,
    collapsedGroups: collapsed,
    onToggleGroup: (p) =>
      setCollapsed((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set(s).add(p))),
    getRowKey: (r) => r.key,
    renderGroupHeader: (p, count) => (
      <HStack gap={2} vAlign="center">
        <Text type="label">{label(p)}</Text>
        <Text type="supporting" color="secondary">
          {t("accounts.table.group", { count, ready: ready.get(p) ?? 0 })}
        </Text>
      </HStack>
    ),
  });
  const items = grouped.data;
  const indexOf = useMemo(() => new Map(items.map((r, i) => [r, i])), [items]);

  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const [holder, setHolder] = useState<HTMLElement | null>(null);
  const anchor = useCallback((el: HTMLElement | null) => {
    setHolder(el);
    setScroller(scrollParent(el));
    setBody(el?.querySelector("tbody") ?? null);
  }, []);
  const margin = useScrollMargin(scroller, body);
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualizer's functions are read on every render, which is what this table wants
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_ESTIMATE,
    overscan: OVERSCAN,
    scrollMargin: margin,
    getItemKey: (i) => grouped.idKey(items[i]),
  });

  const windowed = virtualizer.getVirtualItems();
  const first = windowed[0];
  const last = windowed[windowed.length - 1];
  const above = first ? first.start - margin : 0;
  const below = last ? virtualizer.getTotalSize() - (last.end - margin) : 0;
  const spacer = (key: string, height: number) => ({ key, spacer: height }) as unknown as Row;
  const data = [
    ...(above > 0 ? [spacer("above", above)] : []),
    ...windowed.map((v) => items[v.index]),
    ...(below > 0 ? [spacer("below", below)] : []),
  ];
  const scrollToIndex = useCallback(
    (index: number) => virtualizer.scrollToIndex(index, { align: "auto" }),
    [virtualizer],
  );
  const roving = useRoving(items, grouped.idKey, holder, scrollToIndex, props.openId);
  const rowPlugin = useRowPlugin(props, virtualizer.measureElement, indexOf, roving);
  const plugins = useMemo(
    () => ({ rows: rowPlugin, grouped: grouped.plugin }),
    [rowPlugin, grouped.plugin],
  );

  return (
    <VStack gap={0} ref={anchor}>
      <Table<Row>
        data={data}
        columns={columns}
        idKey={(r) => (spacerOf(r) !== undefined ? `__spacer_${r.key}` : grouped.idKey(r))}
        dividers="rows"
        hasHover
        verticalAlign="top"
        plugins={plugins}
        rowIndexStart={first ? Math.max(1, first.index) : 1}
        rowCount={items.length}
      />
    </VStack>
  );
}

const LOADING_ROWS = 8;
const placeholders = Array.from({ length: LOADING_ROWS }, (_, i) => ({ key: String(i) }));

/** The table's shape while the first list loads: its columns over eight skeleton rows. */
export function LoadingTable() {
  const cell = (r: { key: string }) => (
    <Skeleton width="100%" height={layout.valueSkeleton.height} index={Number(r.key)} />
  );
  const columns: TableColumn<{ key: string }>[] = [
    {
      key: "status",
      width: proportional(1),
      header: t("accounts.columns.status"),
      renderCell: cell,
    },
    {
      key: "account",
      header: t("accounts.columns.account"),
      width: proportional(1.5),
      renderCell: cell,
    },
    {
      key: "session",
      width: proportional(1),
      header: t("accounts.columns.session"),
      renderCell: cell,
    },
    {
      key: "weekly",
      width: proportional(1),
      header: t("accounts.columns.weekly"),
      renderCell: cell,
    },
    {
      key: "requests",
      width: proportional(1.5),
      header: t("accounts.columns.requests"),
      renderCell: cell,
    },
    {
      key: "lastUsed",
      width: proportional(1),
      header: t("accounts.columns.lastUsed"),
      renderCell: cell,
    },
  ];
  return (
    <VStack gap={0} aria-busy aria-label={t("accounts.page.loading")}>
      <Table data={placeholders} columns={columns} idKey="key" dividers="rows" />
    </VStack>
  );
}
