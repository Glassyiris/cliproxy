import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { layout } from "../../themes/site/layout.ts";

type Row = { id: string };
const rows: Row[] = [{ id: "a" }, { id: "b" }, { id: "c" }];

/** Placeholder rows in the shape of a table that is still loading. */
export function SkeletonTable({
  headers,
  density,
}: {
  headers: string[];
  density?: "compact" | "balanced";
}) {
  const columns: TableColumn<Row>[] = headers.map((header) => ({
    key: header,
    header,
    renderCell: () => (
      <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
    ),
  }));
  return <Table<Row> data={rows} columns={columns} idKey="id" density={density} />;
}
