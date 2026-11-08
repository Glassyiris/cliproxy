import { Skeleton } from "@astryxdesign/core/Skeleton";
import { VStack } from "@astryxdesign/core/Layout";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";

type Row = { id: string };
const rows: Row[] = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

/** Placeholder rows under the real headers while the table loads (table-filter:1882-1945). */
export function SkeletonTable({ headers }: { headers: string[] }) {
  const columns: TableColumn<Row>[] = headers.map((header) => ({
    key: header,
    header,
    renderCell: () => (
      <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
    ),
  }));
  // In the same stack as the loaded table and its pager, so the table keeps its inset.
  return (
    <VStack gap={roles.gap.card}>
      <Table<Row>
        data={rows}
        columns={columns}
        idKey="id"
        density={roles.table.density}
        aria-busy
      />
    </VStack>
  );
}
