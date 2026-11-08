import type { ReactNode } from "react";
import { VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { layout } from "../themes/site/layout.ts";
import { roles } from "../themes/site/roles.ts";
import { TwoLines } from "./TwoLines.tsx";

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

const LIST_LOADING_ROWS = 8;
const listPlaceholders = Array.from({ length: LIST_LOADING_ROWS }, (_, i) => ({ key: String(i) }));

const twoLineCell = (r: { key: string }) => (
  <TwoLines
    first={<Skeleton width="100%" height={layout.valueSkeleton.height} index={Number(r.key)} />}
    second={"\u00a0"}
  />
);

/**
 * A credential list's shape while its first read is pending (Accounts, Provider keys): its
 * columns over eight skeleton rows of two lines, so the rows land where the skeleton was.
 */
export function ListSkeleton({
  label,
  columns,
}: {
  label: string;
  columns: { key: string; header: string; width: TableColumn<{ key: string }>["width"] }[];
}) {
  return (
    <VStack gap={0} aria-busy aria-label={label}>
      <Table
        data={listPlaceholders}
        columns={columns.map((c) => ({ ...c, renderCell: twoLineCell }))}
        idKey="key"
        density={roles.table.density}
        dividers="rows"
      />
    </VStack>
  );
}
