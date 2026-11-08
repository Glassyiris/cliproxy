import { useState } from "react";
import { Eye, Plug, Trash2 } from "lucide-react";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack } from "@astryxdesign/core/Layout";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { loadingCell, placeholderRows, type LoadingRow } from "../../components/loadingRows.tsx";
import { mask } from "../../lib/client-keys.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { roles } from "../../themes/site/roles.ts";

type Key = { value: string; index: number };
type Row = LoadingRow<Key>;

function RevealKey({ isShown, onToggle }: { isShown: boolean; onToggle: () => void }) {
  const label = isShown ? t("keys.row.hide") : t("keys.row.show");
  return (
    <IconButton
      label={label}
      tooltip={label}
      size={roles.rowAction.size}
      variant={roles.rowAction.variant}
      icon={<Icon icon={isShown ? "eyeSlash" : Eye} size="sm" />}
      aria-pressed={isShown}
      onClick={onToggle}
    />
  );
}

/** Copies one full key; its own clipboard state, so only this row shows the check. */
function CopyKey({ value }: { value: string }) {
  const { copy, isCopied } = useClipboard();
  return (
    <IconButton
      label={t("keys.row.copy")}
      tooltip={t("keys.row.copy")}
      size={roles.rowAction.size}
      variant={roles.rowAction.variant}
      icon={<Icon icon={isCopied ? "check" : "copy"} size="sm" />}
      onClick={() =>
        void copy(value).then((ok) =>
          ok ? notify("success", t("keys.row.copied")) : notify("error", t("keys.row.copyFailed")),
        )
      }
    />
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
  // Row actions sit together at the end (owner, 2026-11-08: 「為什麼按鈕不放右邊」), so the
  // reveal state lives here and the key cell only draws the key.
  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (index: number) =>
    setShown((was) => {
      const next = new Set(was);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  const columns: TableColumn<Row>[] = [
    {
      key: "value",
      header: t("keys.table.key"),
      renderCell: loadingCell(({ value, index }: Key) => (
        <Text type={roles.textType.identifier}>{shown.has(index) ? value : mask(value)}</Text>
      )),
    },
    {
      key: "actions",
      header: t("keys.table.actions"),
      align: "end",
      renderCell: ({ item }) =>
        item === null ? null : (
          <HStack gap={1} vAlign="center" hAlign="end">
            <RevealKey isShown={shown.has(item.index)} onToggle={() => toggle(item.index)} />
            <CopyKey value={item.value} />
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
