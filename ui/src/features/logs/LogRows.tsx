// The log lines as the table-filter template's table. Astryx Table has no virtualizer, so the
// body is windowed with @tanstack/react-virtual as Accounts does: the table gets only the lines
// in view, between two spacer rows as tall as the lines left out. The page's content region
// scrolls; it follows new lines only while it is scrolled to the end.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import * as stylex from "@stylexjs/stylex";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import {
  Table,
  TableCell,
  pixel,
  proportional,
  type TableColumn,
  type TablePlugin,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Token, type TokenProps } from "@astryxdesign/core/Token";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import type { LogLine } from "./lines.ts";

const styles = stylex.create({
  spacer: (height: number) => ({ height, paddingBlock: 0 }),
});

// A first guess for a line's height, one row of text or, stacked, three; each is measured.
const ROW_ESTIMATE = { wide: 38, stacked: 82 };
const OVERSCAN = 12;
// The three short columns are as wide as their value on one line; the message takes the rest.
const SHORT = pixel(layout.shortValueColumn);
const MESSAGE = proportional(1, { minWidth: layout.tableColumnFloor });
// How close to the end still counts as being at the end.
const END_SLACK = 48;

type Spacer = { key: "above" | "below"; spacer: number };
type Item = LogLine | Spacer;
const isSpacer = (item: Item): item is Spacer => "spacer" in item;

/** The nearest ancestor that scrolls vertically: the page's content region. */
function scrollParent(el: HTMLElement | null) {
  for (let p = el?.parentElement; p; p = p.parentElement)
    if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  return null;
}

/** Where the table body starts in the scrolled content; the toolbar and banners above it change. */
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

/**
 * Keeps the scroller at its end while the reader leaves it there: whenever the content grows (new
 * lines, a line measured taller than its guess, a banner after the lines), it scrolls to the end
 * again. Scrolling up stops that; scrolling back to the end starts it.
 */
function useStickToEnd(scroller: HTMLElement | null, holder: HTMLElement | null) {
  useEffect(() => {
    // The tab's content holds the lines and the banner after them; the scroller's own children
    // keep their size while it grows.
    const content = holder?.parentElement;
    if (!scroller || !content) return;
    let atEnd = true;
    let lastTop = scroller.scrollTop;
    // Only moving up leaves the end: Chrome fires a scroll a pixel down, with the new lines
    // already counted in the height, before the content's resize is observed.
    const read = () => {
      const top = scroller.scrollTop;
      if (scroller.scrollHeight - top - scroller.clientHeight <= END_SLACK) atEnd = true;
      else if (top < lastTop) atEnd = false;
      lastTop = top;
    };
    const toEnd = () => {
      if (atEnd) scroller.scrollTop = scroller.scrollHeight;
    };
    scroller.addEventListener("scroll", read, { passive: true });
    const observer = new ResizeObserver(toEnd);
    observer.observe(content);
    return () => {
      scroller.removeEventListener("scroll", read);
      observer.disconnect();
    };
  }, [scroller, holder]);
}

function Time({ line }: { line: LogLine }) {
  return (
    <Text color="secondary" hasTabularNumbers textWrap="nowrap">
      {line.parsed?.time}
    </Text>
  );
}

function RequestLink({ line, query }: { line: LogLine; query: string }) {
  const id = line.parsed?.requestId;
  return (
    id && (
      <Link href={`#activity/${encodeURIComponent(id)}${query}`}>
        <Text type="code" color="inherit" textWrap="nowrap">
          {id}
        </Text>
      </Link>
    )
  );
}

// The server's logrus levels; the theme maps red and yellow to the error and warning colours.
const LEVEL_COLOR: Record<string, TokenProps["color"]> = {
  panic: "red",
  fatal: "red",
  error: "red",
  warn: "yellow",
  warning: "yellow",
};

const Level = ({ line }: { line: LogLine }) =>
  line.parsed && (
    <Token label={line.parsed.level} size="sm" color={LEVEL_COLOR[line.parsed.level]} />
  );

const Message = ({ line }: { line: LogLine }) => (
  <Text type="code">{line.parsed?.message ?? line.text}</Text>
);

/**
 * Four columns; stacked (on a phone, or beside the open request panel) one, with the time, request
 * and level over the message, so the message keeps the list's whole width.
 */
function columnsOf(query: string, isStacked: boolean): TableColumn<Item>[] {
  const cell = (render: (line: LogLine) => ReactNode) => (item: Item) =>
    isSpacer(item) ? null : render(item);
  if (isStacked)
    return [
      {
        key: "line",
        header: t("logs.columns.message"),
        renderCell: cell((l) => (
          <VStack gap={1}>
            {l.parsed && (
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Time line={l} />
                <RequestLink line={l} query={query} />
                <Level line={l} />
              </HStack>
            )}
            <Message line={l} />
          </VStack>
        )),
      },
    ];
  return [
    {
      key: "time",
      header: t("logs.columns.time"),
      width: SHORT,
      renderCell: cell((l) => <Time line={l} />),
    },
    {
      key: "request",
      header: t("logs.columns.request"),
      width: SHORT,
      renderCell: cell((l) => <RequestLink line={l} query={query} />),
    },
    {
      key: "level",
      header: t("logs.columns.level"),
      width: SHORT,
      renderCell: cell((l) => <Level line={l} />),
    },
    {
      key: "message",
      header: t("logs.columns.message"),
      width: MESSAGE,
      renderCell: cell((l) => <Message line={l} />),
    },
  ];
}

function moveOf(key: string, index: number, count: number) {
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

type Ranges = { rendered: [number, number]; inView: [number, number] };

const clamp = (index: number, [from, to]: [number, number]) => Math.min(Math.max(index, from), to);

/**
 * The roving focus over the windowed lines: one line is in the tab order, the arrow keys, Home
 * and End move it, scrolling the line into the window before focusing it. Links in other lines
 * leave the tab order, so Tab enters and leaves the log once. When the line in the tab order
 * leaves the window, the nearest line in view takes its place, so Tab always reaches the log.
 */
function useRoving(
  lines: LogLine[],
  holder: HTMLElement | null,
  scrollToIndex: (index: number) => void,
  { rendered, inView }: Ranges,
) {
  // By key, since lines come and go at both ends while following.
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const found = lines.findIndex((l) => l.key === activeKey);
  const chosen = found >= 0 ? found : Math.max(0, lines.length - 1);
  const active = clamp(chosen, rendered) === chosen ? chosen : clamp(chosen, inView);
  const rowAt = useCallback(
    (index: number) => holder?.querySelector<HTMLElement>(`tbody tr[data-index="${index}"]`),
    [holder],
  );
  const moveTo = useCallback(
    (index: number) => {
      setActiveKey(lines[index]?.key ?? null);
      // Focus already in the line (a clicked request link) stays there: scrolling and focusing the
      // row would move the link from under the pointer before its click lands.
      if (rowAt(index)?.contains(document.activeElement)) return;
      scrollToIndex(index);
      let tries = 10;
      const focus = () => {
        const row = rowAt(index);
        if (row) row.focus();
        else if (tries-- > 0) requestAnimationFrame(focus);
      };
      requestAnimationFrame(focus);
    },
    [lines, rowAt, scrollToIndex],
  );
  useLayoutEffect(() => {
    for (const link of holder?.querySelectorAll<HTMLElement>("tbody tr[data-index] a") ?? [])
      link.tabIndex = link.closest("tr")?.dataset.index === String(active) ? 0 : -1;
  });
  return { active, moveTo };
}

function useRowPlugin(
  measure: (el: HTMLTableRowElement | null) => void,
  indexOf: Map<LogLine, number>,
  { active, count, moveTo }: { active: number; count: number; moveTo: (i: number) => void },
) {
  return useMemo<TablePlugin<Item>>(
    () => ({
      transformBodyRow: (props, item) => {
        if (isSpacer(item))
          return {
            ...props,
            htmlProps: { ...props.htmlProps, "aria-hidden": true },
            children: <TableCell colSpan={999} xstyle={styles.spacer(item.spacer)} />,
          };
        const index = indexOf.get(item) ?? 0;
        return {
          ...props,
          ref: measure,
          htmlProps: {
            ...props.htmlProps,
            "data-index": index,
            tabIndex: index === active ? 0 : -1,
            onFocus: () => {
              if (index !== active) moveTo(index);
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
      },
    }),
    [measure, indexOf, active, count, moveTo],
  );
}

/** One column on a phone, and beside the open request panel at any width. */
function useIsStacked(isPanelOpen: boolean) {
  return useAppShellMobile().isMobile || isPanelOpen;
}

export function LogRows(props: { lines: LogLine[]; query: string; isPanelOpen: boolean }) {
  const { lines, query } = props;
  const isStacked = useIsStacked(props.isPanelOpen);
  const columns = useMemo(() => columnsOf(query, isStacked), [query, isStacked]);
  const indexOf = useMemo(() => new Map(lines.map((l, i) => [l, i])), [lines]);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const [holder, setHolder] = useState<HTMLElement | null>(null);
  const anchor = useCallback((el: HTMLElement | null) => {
    setHolder(el);
    setScroller(scrollParent(el));
    setBody(el?.querySelector("tbody") ?? null);
  }, []);
  const margin = useScrollMargin(scroller, body);
  useStickToEnd(scroller, holder);
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualizer's functions are read on every render, which is what this table wants
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller,
    estimateSize: () => (isStacked ? ROW_ESTIMATE.stacked : ROW_ESTIMATE.wide),
    overscan: OVERSCAN,
    scrollMargin: margin,
    getItemKey: (i) => lines[i].key,
    // Trimming the oldest lines at the cap keeps the line in view where it is; at the end, new
    // lines are followed instead.
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: END_SLACK,
  });
  const scrollToIndex = useCallback(
    (index: number) => virtualizer.scrollToIndex(index, { align: "auto" }),
    [virtualizer],
  );
  const windowed = virtualizer.getVirtualItems();
  const first = windowed[0];
  const last = windowed[windowed.length - 1];
  const rendered: [number, number] = [first?.index ?? 0, last?.index ?? 0];
  const { range } = virtualizer;
  const roving = useRoving(lines, holder, scrollToIndex, {
    rendered,
    inView: range ? [range.startIndex, range.endIndex] : rendered,
  });
  const rowPlugin = useRowPlugin(virtualizer.measureElement, indexOf, {
    ...roving,
    count: lines.length,
  });
  const plugins = useMemo(() => ({ rows: rowPlugin }), [rowPlugin]);

  const above = first ? first.start - margin : 0;
  const below = last ? virtualizer.getTotalSize() - (last.end - margin) : 0;
  const data: Item[] = [
    ...(above > 0 ? [{ key: "above", spacer: above } as const] : []),
    ...windowed.map((v) => lines[v.index]),
    ...(below > 0 ? [{ key: "below", spacer: below } as const] : []),
  ];

  return (
    // Rows mounted by scrolling are not new output: the log does not announce them.
    <VStack gap={0} ref={anchor} role="log" aria-live="off" aria-label={t("logs.lines.label")}>
      <Table<Item>
        data={data}
        columns={columns}
        idKey={(item) => (isSpacer(item) ? `spacer-${item.key}` : item.key)}
        dividers="rows"
        hasHover
        verticalAlign="top"
        plugins={plugins}
        // The spacer above takes the ordinal of the first line it stands for.
        rowIndexStart={above > 0 ? first.index : 1}
        rowCount={lines.length}
      />
    </VStack>
  );
}

const placeholders = Array.from({ length: 8 }, (_, i) => ({ key: String(i) }));

/** The log's shape while the first read is pending: its columns over skeleton lines. */
export function LoadingRows({ isPanelOpen }: { isPanelOpen: boolean }) {
  const isStacked = useIsStacked(isPanelOpen);
  const cell = (r: { key: string }) => (
    <Skeleton width="100%" height={layout.valueSkeleton.height} index={Number(r.key)} />
  );
  const shape: [string, string][] = isStacked
    ? [["line", t("logs.columns.message")]]
    : [
        ["time", t("logs.columns.time")],
        ["request", t("logs.columns.request")],
        ["level", t("logs.columns.level")],
        ["message", t("logs.columns.message")],
      ];
  const columns: TableColumn<{ key: string }>[] = shape.map(([key, header]) => ({
    key,
    header,
    width: key === "message" ? MESSAGE : SHORT,
    renderCell: cell,
  }));
  return (
    <VStack gap={0} aria-busy aria-label={t("logs.lines.loading")}>
      <Table data={placeholders} columns={columns} idKey="key" dividers="rows" />
    </VStack>
  );
}
