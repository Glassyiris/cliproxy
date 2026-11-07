import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Code } from "@astryxdesign/core/Code";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack } from "@astryxdesign/core/Layout";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { mask } from "../../lib/client-keys.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { layout } from "../../themes/site/layout.ts";

type Row = { id: string; value: string };

function RowActions({ value, onRemove }: { value: string; onRemove: (key: string) => void }) {
  const { copy, isCopied } = useClipboard();
  return (
    <HStack gap={1} vAlign="center" hAlign="end">
      <IconButton
        label={t("keys.row.copy")}
        tooltip={t("keys.row.copy")}
        size="sm"
        variant="ghost"
        icon={<Icon icon={isCopied ? "check" : "copy"} size="sm" />}
        onClick={() =>
          void copy(value).then((ok) =>
            ok
              ? notify("success", t("keys.row.copied"))
              : notify("error", t("keys.row.copyFailed")),
          )
        }
      />
      <MoreMenu
        label={t("keys.row.menu")}
        size="sm"
        items={[
          {
            label: t("keys.row.remove"),
            variant: "destructive",
            onClick: () => onRemove(value),
          },
        ]}
      />
    </HStack>
  );
}

const skeletonRows: Row[] = [
  { id: "a", value: "" },
  { id: "b", value: "" },
  { id: "c", value: "" },
];

export function KeyTable({
  keys,
  revealed,
  onRemove,
}: {
  /** Undefined while the config loads: placeholder rows in the table's shape. */
  keys: string[] | undefined;
  revealed: boolean;
  onRemove: (key: string) => void;
}) {
  const loading = keys === undefined;
  const columns: TableColumn<Row>[] = [
    {
      key: "value",
      header: t("keys.table.key"),
      renderCell: (row) =>
        loading ? (
          <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
        ) : (
          <Code>{revealed ? row.value : mask(row.value)}</Code>
        ),
    },
    {
      key: "actions",
      header: t("keys.table.actions"),
      align: "end",
      renderCell: (row) => (loading ? null : <RowActions value={row.value} onRemove={onRemove} />),
    },
  ];
  const data = keys?.map((value, index) => ({ id: String(index), value })) ?? skeletonRows;
  return <Table<Row> data={data} columns={columns} idKey="id" hasHover={!loading} />;
}
