// The account list of the table-inbox template: Astryx Table in `balanced` density with no column
// dividers, every row a doorway to the detail (click, Enter or Space; `isRowItself` keeps the
// checkbox from opening it), the open row one step past hover. The columns follow the room the
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
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import * as stylex from "@stylexjs/stylex";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import {
  Table,
  TableCell,
  proportional,
  useTableSelectionState,
  type TableColumn,
  type TablePlugin,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { QuotaWindow } from "../../components/QuotaWindow.tsx";
import { RequestSparkline } from "../../components/RequestSparkline.tsx";
import { lampStatus, StatusLamp } from "../../components/StatusLamp.tsx";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import type { ListShape } from "../../components/listShape.ts";
import { layout } from "../../themes/site/layout.ts";
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

/** table-inbox `INTERACTIVE_WITHIN_ROW`: controls inside the row that are not the row. */
const isRowItself = (target: EventTarget | null) =>
  !(target as HTMLElement | null)?.closest(
    'button, input, a, label, [role="checkbox"], [role="button"], [role="img"]',
  );

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

/** A cell of two lines: the value, and a secondary line under it. */
function TwoLines({ first, second }: { first: ReactNode; second: string }) {
  return (
    <VStack gap={0.5}>
      {first}
      <Text type={roles.textType.supporting} color="secondary" maxLines={1} hasTabularNumbers>
        {second}
      </Text>
    </VStack>
  );
}

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

const share = (n: number) => proportional(n, { minWidth: layout.tableColumnFloor });

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
  width: number,
): TableColumn<Row> {
  return {
    key: "account",
    width: share(width),
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
    return [accountColumn(selection, allSelected, cell, (r) => <Summary row={r} now={now} />, 1)];
  const columns: TableColumn<Row>[] = [
    accountColumn(
      selection,
      allSelected,
      cell,
      (r) => <TwoLines first={<Name row={r} />} second={accountLine(r)} />,
      2,
    ),
    {
      key: "status",
      width: share(2),
      header: t("accounts.columns.status"),
      renderCell: cell((r) => <Status row={r} />),
    },
    ...(["session", "weekly"] as const).map((k) => ({
      key: k,
      width: share(1.25),
      header: k === "session" ? t("accounts.columns.session") : t("accounts.columns.weekly"),
      renderCell: cell((r) => <QuotaWindow bar={r.view[k]} now={now} isCompact />),
    })),
  ];
  if (shape === "tight") return columns;
  return [
    ...columns,
    {
      key: "recovery",
      width: share(1.25),
      header: t("accounts.columns.recovery"),
      renderCell: cell((r) => <Recovery row={r} now={now} />),
    },
    {
      key: "requests",
      width: share(1.5),
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
            onKeyDown: (event) => {
              if (!isRowItself(event.target)) return;
              const to = moveOf(event.key, indexOf.get(item) ?? 0);
              if (to === null && event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (to === null) onToggle(item);
              else moveTo(to);
            },
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

/** Where an arrow, Home or End key moves from the row at `index` (clamped later); else null. */
function moveOf(key: string, index: number) {
  if (key === "ArrowDown") return index + 1;
  if (key === "ArrowUp") return index - 1;
  if (key === "Home") return 0;
  if (key === "End") return Infinity;
  return null;
}

/** Closing the panel brings focus back to the row that opened it, scrolled into the window. */
function useReturnFocus(
  shown: Row[],
  openId: string,
  holder: HTMLElement | null,
  scrollToIndex: (index: number) => void,
) {
  const opened = useRef(openId);
  useEffect(() => {
    const was = opened.current;
    opened.current = openId;
    if (!was || openId) return;
    const index = shown.findIndex((r) => r.id === was);
    if (index < 0) return;
    scrollToIndex(index);
    requestAnimationFrame(() =>
      holder
        ?.querySelector<HTMLElement>(`tbody tr[data-account="${CSS.escape(was)}"]`)
        ?.focus({ preventScroll: true }),
    );
  }, [openId, shown, holder, scrollToIndex]);
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
  useReturnFocus(shown, props.openId, holder, scrollToIndex);
  // A row outside the window is scrolled in first and focused once it is rendered.
  const moveTo = useCallback(
    (index: number) => {
      const to = Math.max(0, Math.min(shown.length - 1, index));
      const rowAt = () => holder?.querySelector<HTMLElement>(`tbody tr[data-index="${to}"]`);
      const rendered = rowAt();
      if (rendered) return rendered.focus();
      scrollToIndex(to);
      let tries = 60;
      const focus = () => {
        const row = rowAt();
        if (row) row.focus();
        else if (tries-- > 0) requestAnimationFrame(focus);
      };
      requestAnimationFrame(focus);
    },
    [shown.length, holder, scrollToIndex],
  );
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

const LOADING_ROWS = 8;
const placeholders = Array.from({ length: LOADING_ROWS }, (_, i) => ({ key: String(i) }));

/** The list's shape while the first read is pending: its columns over eight skeleton rows. */
export function LoadingTable({ shape }: { shape: ListShape }) {
  const cell = (r: { key: string }) => (
    <TwoLines
      first={<Skeleton width="100%" height={layout.valueSkeleton.height} index={Number(r.key)} />}
      second={" "}
    />
  );
  const keys =
    shape === "stacked"
      ? ["account"]
      : shape === "tight"
        ? ["account", "status", "session", "weekly"]
        : ["account", "status", "session", "weekly", "recovery", "requests"];
  const columns: TableColumn<{ key: string }>[] = keys.map((key) => ({
    key,
    header: headers[key](),
    width: share(key === "account" || key === "status" ? 2 : 1.25),
    renderCell: cell,
  }));
  return (
    <VStack gap={0} aria-busy aria-label={t("accounts.page.loading")}>
      <Table
        data={placeholders}
        columns={columns}
        idKey="key"
        density={roles.table.density}
        dividers="rows"
      />
    </VStack>
  );
}
