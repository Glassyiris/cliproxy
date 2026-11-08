import type { ReactNode } from "react";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { layout } from "../themes/site/layout.ts";

/** A table row whose `item` is null while the table's data loads. */
export type LoadingRow<T> = { id: string; item: T | null };

/** Three placeholder rows, so a loading table keeps its shape. */
export const placeholderRows: LoadingRow<never>[] = [
  { id: "a", item: null },
  { id: "b", item: null },
  { id: "c", item: null },
];

/** A `renderCell` that draws `render(item)`, or a value-sized skeleton on a placeholder row. */
export const loadingCell =
  <T,>(render: (item: T) => ReactNode) =>
  ({ item }: LoadingRow<T>) =>
    item === null ? (
      <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
    ) : (
      render(item)
    );
