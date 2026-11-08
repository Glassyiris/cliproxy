// How much room a list has, as the table-inbox template asks it (`useSurfaceWidth`): the list's
// own width, not the window's, measured before paint so the first frame is laid out for it. Below
// the first width the rows stack into one summary cell; below the second the columns read last go.
import { useLayoutEffect, useRef, useState } from "react";

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
