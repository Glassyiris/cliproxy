// The account list of the table-inbox template: Astryx Table in `balanced` density with no column
// dividers, every row a doorway to the detail (click, Enter or Space, Escape closes it; the row keys are
// `components/rowKeys.ts`, shared with Provider keys; `isRowItself` keeps the checkbox from opening it), the open row one step past hover. The columns follow the room the
// list has, as the template's do (`STACK_ROWS_BELOW`, `TIGHTEN_COLUMNS_BELOW`): wide, the quota
// windows, recovery and requests; tight (beside the open panel), the quota windows only; stacked
// (a phone), one summary cell per row with the name first. Deviation: the stacked rows keep their
// checkbox, which the template drops, so batch actions still reach every account on a phone. Astryx Table has no virtualizer, so the body is windowed with @tanstack/react-virtual
// as LogRows.tsx does it: the table gets the rows in view between two spacer rows as tall as the
// rows left out.
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import * as stylex from "@stylexjs/stylex";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import {
  Table,
  TableCell,
  useTableSelectionState,
  type TableColumn,
  type TablePlugin,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { QuotaWindow } from "../../components/QuotaWindow.tsx";
import { RequestSparkline } from "../../components/RequestSparkline.tsx";
import { listColumns, type ListShape } from "../../components/listShape.ts";
import { ListSkeleton } from "../../components/loadingRows.tsx";
import { isRowItself, onRowKey, rowAt, useReturnFocus } from "../../components/rowKeys.ts";
import { lampStatus, StatusLamp } from "../../components/StatusLamp.tsx";
import { TwoLines } from "../../components/TwoLines.tsx";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import type { Row } from "./rows.ts";
import { reasonOf, recoveryOf, statusOf } from "./words.ts";

const styles = stylex.create({
  clickableRow: { cursor: "pointer" },
  activeRow: {
    backgroundColor: colorVars["--color-overlay-pressed"],
    "--table-row-overlay": colorVars["--color-overlay-pressed"],
  },
  spacer: (height: number) => ({ height, paddingBlock: 0 }),
});

// A first guess for a row's height; every rendered row is measured, so it only steers the
// scrollbar until then.
const ROW_ESTIMATE = 64;
const OVERSCAN = 8;

/** A spacer stands for the rows above or below the window; it has no account. */
type Spacer = { spacer: number; key: string };
const spacerOf = (item: Row) => {
  const height = (item as unknown as Partial<Spacer>).spacer;
  return typeof height === "number" ? height : undefined;
};

/** Where the table body starts in the scrolled content, measured again on every resize. */
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
  shape: ListShape;
};

type Selection = ReturnType<typeof useTableSelectionState<Row>>["selectionConfig"];

function Name({ row }: { row: Row }) {
  return (
    <Text type={roles.textType.body} maxLines={1}>
      {row.name}
    </Text>
  );
}

function Status({ row }: { row: Row }) {
  return (
    <TwoLines
      first={<StatusLamp status={lampStatus[row.view.lamp]} label={statusOf(row.view)} />}
      second={reasonOf(row.view, row.account)}
    />
  );
}

function Recovery({ row, now }: { row: Row; now: number }) {
  const r = recoveryOf(row.view, now);
  return (
    <TwoLines
      first={
        <Text type={roles.textType.body} maxLines={1} hasTabularNumbers>
          {r.first}
        </Text>
      }
      second={r.second}
    />
  );
}

/** The phone's summary row: name and provider, then status and reason, then when it comes back. */
function Summary({ row, now }: { row: Row; now: number }) {
  const r = recoveryOf(row.view, now);
  const reason = reasonOf(row.view, row.account);
  return (
    <VStack gap={0.5}>
      <Name row={row} />
      <Text type={roles.textType.supporting} color="secondary" maxLines={1}>
        {accountLine(row)}
      </Text>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <StatusLamp status={lampStatus[row.view.lamp]} label={statusOf(row.view)} />
        {reason && (
          <Text type={roles.textType.supporting} color="secondary" maxLines={1}>
            {reason}
          </Text>
        )}
      </HStack>
      {!row.view.ready && (
        <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
          {r.second
            ? t("accounts.row.recoveryAt", { when: r.first, at: r.second })
            : t("accounts.row.recovery", { when: r.first })}
        </Text>
      )}
    </VStack>
  );
}

/** Each column's width, the same for the list and its skeleton (shared with Provider keys). */
const widths = {
  account: listColumns.name,
  status: listColumns.status,
  session: listColumns.window,
  weekly: listColumns.window,
  recovery: listColumns.window,
  requests: listColumns.requests,
};

type Cell = (render: (r: Row) => ReactNode) => (r: Row) => ReactNode;

/** The account's second line: provider and plan, then its note, else its file. */
const accountLine = (r: Row) =>
  [[label(r.provider), r.account.id_token?.plan_type].filter(Boolean).join(" "), r.account.note]
    .filter(Boolean)
    .join(", ");

/** The name column, with the selection checkbox in its header and in each row. */
function accountColumn(
  selection: Selection,
  allSelected: boolean,
  cell: Cell,
  content: (r: Row) => ReactNode,
): TableColumn<Row> {
  return {
    key: "account",
    width: widths.account,
    header: (
      <HStack gap={2} vAlign="center">
        <CheckboxInput
          label={t("accounts.table.selectShown")}
          isLabelHidden
          value={allSelected ? true : selection.getIsIndeterminate?.() ? "indeterminate" : false}
          onChange={(checked) => selection.onSelectAll({ isAllSelected: checked })}
        />
        {t("accounts.columns.account")}
      </HStack>
    ),
    renderCell: cell((r) => (
      <HStack gap={2} vAlign="start">
        <CheckboxInput
          label={t("accounts.table.select", { name: r.name })}
          isLabelHidden
          value={selection.getIsItemSelected(r)}
          onChange={(checked) => selection.onSelectItem({ item: r, isSelected: checked })}
        />
        <StackItem size="fill">{content(r)}</StackItem>
      </HStack>
    )),
  };
}

function columnsOf(
  selection: Selection,
  allSelected: boolean,
  now: number,
  shape: ListShape,
): TableColumn<Row>[] {
  const cell: Cell = (render) => (r) => (spacerOf(r) === undefined ? render(r) : null);
  if (shape === "stacked")
    return [
      {
        ...accountColumn(selection, allSelected, cell, (r) => <Summary row={r} now={now} />),
        width: listColumns.stacked,
      },
    ];
  const columns: TableColumn<Row>[] = [
    accountColumn(selection, allSelected, cell, (r) => (
      <TwoLines first={<Name row={r} />} second={accountLine(r)} />
    )),
    {
      key: "status",
      width: widths.status,
      header: t("accounts.columns.status"),
      renderCell: cell((r) => <Status row={r} />),
    },
    ...(["session", "weekly"] as const).map((k) => ({
      key: k,
      width: widths[k],
      header: k === "session" ? t("accounts.columns.session") : t("accounts.columns.weekly"),
      renderCell: cell((r) => <QuotaWindow bar={r.view[k]} now={now} isCompact />),
    })),
  ];
  if (shape === "tight") return columns;
  return [
    ...columns,
    {
      key: "recovery",
      width: widths.recovery,
      header: t("accounts.columns.recovery"),
      renderCell: cell((r) => <Recovery row={r} now={now} />),
    },
    {
      key: "requests",
      width: widths.requests,
      header: t("accounts.columns.requests"),
      renderCell: cell((r) =>
        r.buckets ? (
          <RequestSparkline buckets={r.buckets} times={r.times} />
        ) : (
          <Text type={roles.textType.supporting} color="secondary">
            {t("app.quota.notReported")}
          </Text>
        ),
      ),
    },
  ];
}

function useColumns({ shown, selected, setSelected, now, shape }: TableProps) {
  const { selectionConfig } = useTableSelectionState<Row>({
    data: shown,
    idKey: "key",
    selectedKeys: selected,
    setSelectedKeys: setSelected,
  });
  const all = selectionConfig.getIsAllSelected();
  return useMemo(
    () => columnsOf(selectionConfig, all, now, shape),
    [selectionConfig, all, now, shape],
  );
}

/** The template's row activation, and what the virtualizer needs to measure each row. */
function useRowPlugin(
  { openId, onToggle }: TableProps,
  measure: (el: HTMLTableRowElement | null) => void,
  indexOf: Map<Row, number>,
  moveTo: (index: number) => void,
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
        const isOpen = item.id === openId;
        return {
          ...props,
          ref: measure,
          htmlProps: {
            ...props.htmlProps,
            "data-index": indexOf.get(item) ?? 0,
            "data-account": item.id,
            tabIndex: 0,
            "aria-current": isOpen ? true : undefined,
            onClick: (event) => {
              if (isRowItself(event.target)) onToggle(item);
            },
            onKeyDown: (event) =>
              onRowKey(
                event,
                { index: indexOf.get(item) ?? 0, isOpen, toggle: () => onToggle(item) },
                moveTo,
              ),
          },
          xstyle: props.xstyle.concat(
            isOpen ? [styles.clickableRow, styles.activeRow] : styles.clickableRow,
          ),
        };
      },
    }),
    [openId, onToggle, measure, indexOf, moveTo],
  );
}

/**
 * The windowed list's focus: closing the panel scrolls the row that opened it into the window
 * and focuses it; a move to a row outside the window scrolls it in first and focuses it once it
 * is rendered.
 */
function useRowFocus(
  shown: Row[],
  openId: string,
  holder: HTMLElement | null,
  scrollToIndex: (index: number) => void,
) {
  const reveal = useCallback(
    (id: string) => {
      const index = shown.findIndex((r) => r.id === id);
      if (index >= 0) scrollToIndex(index);
      return index >= 0;
    },
    [shown, scrollToIndex],
  );
  const rowOf = useCallback(
    (id: string) =>
      holder?.querySelector<HTMLElement>(`tbody tr[data-account="${CSS.escape(id)}"]`) ?? null,
    [holder],
  );
  useReturnFocus(openId, reveal, rowOf);
  return useCallback(
    (index: number) => {
      const to = Math.max(0, Math.min(shown.length - 1, index));
      const rendered = rowAt(holder, to);
      if (rendered) return rendered.focus();
      scrollToIndex(to);
      let tries = 60;
      const focus = () => {
        const row = rowAt(holder, to);
        if (row) row.focus();
        else if (tries-- > 0) requestAnimationFrame(focus);
      };
      requestAnimationFrame(focus);
    },
    [shown.length, holder, scrollToIndex],
  );
}

export function AccountTable(props: TableProps) {
  const { shown } = props;
  const columns = useColumns(props);
  const indexOf = useMemo(() => new Map(shown.map((r, i) => [r, i])), [shown]);

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
    count: shown.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_ESTIMATE,
    overscan: OVERSCAN,
    scrollMargin: margin,
    getItemKey: (i) => shown[i].key,
  });

  const windowed = virtualizer.getVirtualItems();
  const first = windowed[0];
  const last = windowed[windowed.length - 1];
  const above = first ? first.start - margin : 0;
  const below = last ? virtualizer.getTotalSize() - (last.end - margin) : 0;
  const spacer = (key: string, height: number) => ({ key, spacer: height }) as unknown as Row;
  const data = [
    ...(above > 0 ? [spacer("above", above)] : []),
    ...windowed.map((v) => shown[v.index]),
    ...(below > 0 ? [spacer("below", below)] : []),
  ];
  const scrollToIndex = useCallback(
    (index: number) => virtualizer.scrollToIndex(index, { align: "auto" }),
    [virtualizer],
  );
  const moveTo = useRowFocus(shown, props.openId, holder, scrollToIndex);
  const rowPlugin = useRowPlugin(props, virtualizer.measureElement, indexOf, moveTo);
  const plugins = useMemo(() => ({ rows: rowPlugin }), [rowPlugin]);

  return (
    <VStack gap={0} ref={anchor}>
      <Table<Row>
        data={data}
        columns={columns}
        idKey={(r) => (spacerOf(r) !== undefined ? `__spacer_${r.key}` : r.key)}
        density={roles.table.density}
        dividers="rows"
        hasHover
        verticalAlign="top"
        plugins={plugins}
        rowIndexStart={first ? first.index + 1 : 1}
        rowCount={shown.length}
      />
    </VStack>
  );
}

const headers: Record<string, () => string> = {
  account: () => t("accounts.columns.account"),
  status: () => t("accounts.columns.status"),
  session: () => t("accounts.columns.session"),
  weekly: () => t("accounts.columns.weekly"),
  recovery: () => t("accounts.columns.recovery"),
  requests: () => t("accounts.columns.requests"),
};

/** The list's shape while the first read is pending: its columns over eight skeleton rows. */
export function LoadingTable({ shape }: { shape: ListShape }) {
  const keys: (keyof typeof widths)[] =
    shape === "stacked"
      ? ["account"]
      : shape === "tight"
        ? ["account", "status", "session", "weekly"]
        : ["account", "status", "session", "weekly", "recovery", "requests"];
  const columns = keys.map((key) => ({
    key,
    header: headers[key](),
    width: shape === "stacked" ? listColumns.stacked : widths[key],
  }));
  return <ListSkeleton label={t("accounts.page.loading")} columns={columns} />;
}
