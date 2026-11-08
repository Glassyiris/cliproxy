import { useState } from "react";
import { Eye, Plug, Trash2 } from "lucide-react";
import { Code } from "@astryxdesign/core/Code";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack } from "@astryxdesign/core/Layout";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { loadingCell, placeholderRows, type LoadingRow } from "../../components/loadingRows.tsx";
import { mask } from "../../lib/client-keys.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { roles } from "../../themes/site/roles.ts";

type Key = { value: string; index: number };
type Row = LoadingRow<Key>;

/** The key masked, with its own reveal and copy beside it. */
function KeyCell({ value }: { value: string }) {
  const { copy, isCopied } = useClipboard();
  const [revealed, setRevealed] = useState(false);
  const reveal = revealed ? t("keys.row.hide") : t("keys.row.show");
  return (
    <HStack gap={1} vAlign="center">
      <Code>{revealed ? value : mask(value)}</Code>
      <IconButton
        label={reveal}
        tooltip={reveal}
        size={roles.rowAction.size}
        variant={roles.rowAction.variant}
        icon={<Icon icon={revealed ? "eyeSlash" : Eye} size="sm" />}
        aria-pressed={revealed}
        onClick={() => setRevealed(!revealed)}
      />
      <IconButton
        label={t("keys.row.copy")}
        tooltip={t("keys.row.copy")}
        size={roles.rowAction.size}
        variant={roles.rowAction.variant}
        icon={<Icon icon={isCopied ? "check" : "copy"} size="sm" />}
        onClick={() =>
          void copy(value).then((ok) =>
            ok
              ? notify("success", t("keys.row.copied"))
              : notify("error", t("keys.row.copyFailed")),
          )
        }
      />
    </HStack>
  );
}

export function KeyTable({
  keys,
  onUse,
  onRevoke,
}: {
  /** Undefined while the config loads: placeholder rows in the table's shape. */
  keys: string[] | undefined;
  onUse: (index: number) => void;
  onRevoke: (key: string) => void;
}) {
  const loading = keys === undefined;
  const columns: TableColumn<Row>[] = [
    {
      key: "value",
      header: t("keys.table.key"),
      renderCell: loadingCell(({ value }: Key) => <KeyCell value={value} />),
    },
    {
      key: "actions",
      header: t("keys.table.actions"),
      align: "end",
      renderCell: ({ item }) =>
        item === null ? null : (
          <HStack gap={1} vAlign="center" hAlign="end">
            <IconButton
              label={t("app.nav.use")}
              tooltip={t("app.nav.use")}
              size={roles.rowAction.size}
              variant={roles.rowAction.variant}
              icon={<Icon icon={Plug} size="sm" />}
              onClick={() => onUse(item.index)}
            />
            <IconButton
              label={t("keys.row.revoke")}
              tooltip={t("keys.row.revoke")}
              size={roles.rowAction.size}
              variant={roles.rowAction.variant}
              icon={<Icon icon={Trash2} size="sm" />}
              onClick={() => onRevoke(item.value)}
            />
          </HStack>
        ),
    },
  ];
  const data =
    keys?.map((value, index) => ({ id: String(index), item: { value, index } })) ?? placeholderRows;
  return (
    <Table<Row>
      data={data}
      columns={columns}
      idKey="id"
      density={roles.table.density}
      hasHover={!loading}
    />
  );
}
