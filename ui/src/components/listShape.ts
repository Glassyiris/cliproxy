// How much room a list has, as the table-inbox template asks it (`useSurfaceWidth`): the list's
// own width, not the window's, measured before paint so the first frame is laid out for it. Below
// the first width the rows stack into one summary cell; below the second the columns read last go.
import { useLayoutEffect, useRef, useState } from "react";
import { pixel, proportional } from "@astryxdesign/core/Table";
import { layout } from "../themes/site/layout.ts";

// table-inbox `STACK_ROWS_BELOW`, `TIGHTEN_COLUMNS_BELOW`.
const STACK_ROWS_BELOW = 560;
const TIGHTEN_COLUMNS_BELOW = 900;
export type ListShape = "wide" | "tight" | "stacked";

export function useListShape() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.offsetWidth);
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const shape: ListShape =
    width > 0 && width < STACK_ROWS_BELOW
      ? "stacked"
      : width > 0 && width < TIGHTEN_COLUMNS_BELOW
        ? "tight"
        : "wide";
  return [ref, shape] as const;
}

/** A column's share of the list's width, never narrower than the table's column floor. */
const share = (n: number) => proportional(n, { minWidth: layout.tableColumnFloor });

// One of Accounts' quota and recovery columns.
const WINDOW = 1.25;

/**
 * The column widths of the credential lists (Accounts, Provider keys), so a name, a status and
 * the requests slot start at the same x on both pages. The name gets the largest share, so a
 * 28-character email fits at 1440 without the panel; the requests column is as wide as its
 * fixed-width content; a stacked row is one cell.
 */
export const listColumns = {
  name: share(2.5),
  status: share(1.5),
  window: share(WINDOW),
  /** Provider keys' keys column: the room of the windows it lacks, wide (three) or tight (two). */
  keys: { wide: share(3 * WINDOW), tight: share(2 * WINDOW) },
  requests: pixel(layout.requests.column),
  stacked: share(1),
};
