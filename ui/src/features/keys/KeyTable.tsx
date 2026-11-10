import { useState } from "react";
import { Eye } from "lucide-react";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack } from "@astryxdesign/core/Layout";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useAction } from "../../app/useAction.ts";
import { icons } from "../../components/icons.ts";
import { loadingCell, placeholderRows, type LoadingRow } from "../../components/loadingRows.tsx";
import { revealClientKey, type ClientKey } from "../../lib/api/clientKeys.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { roles } from "../../themes/site/roles.ts";

type Row = LoadingRow<ClientKey>;
type Revealed = { rev: number; key: string };

function KeyActions({
  resource,
  shown,
  onShow,
  onUse,
  onRevoke,
}: {
  resource: ClientKey;
  shown: boolean;
  onShow: (value?: Revealed) => void;
  onUse: (id: string) => void;
  onRevoke: (resource: ClientKey) => void;
}) {
  const action = useAction();
  const { copy, isCopied } = useClipboard();
  const label = shown ? t("keys.row.hide") : t("keys.row.show");
  return (
    <HStack gap={1} vAlign="center" hAlign="end">
      <IconButton
        label={label}
        tooltip={label}
        size={roles.rowAction.size}
        variant={roles.rowAction.variant}
        icon={<Icon icon={shown ? "eyeSlash" : Eye} size="sm" />}
        aria-pressed={shown}
        isLoading={action.busy}
        onClick={() => {
          if (shown) return onShow();
          void action.run(async () =>
            onShow({ rev: resource.rev, key: await revealClientKey(resource.id) }),
          );
        }}
      />
      <IconButton
        label={t("keys.row.copy")}
        tooltip={t("keys.row.copy")}
        size={roles.rowAction.size}
        variant={roles.rowAction.variant}
        icon={<Icon icon={isCopied ? "check" : "copy"} size="sm" />}
        onClick={() =>
          void action.run(async () => {
            const ok = await copy(await revealClientKey(resource.id));
            notify(ok ? "success" : "error", t(ok ? "keys.row.copied" : "keys.row.copyFailed"));
          })
        }
      />
      <IconButton
        label={t("app.nav.use")}
        tooltip={t("app.nav.use")}
        size={roles.rowAction.size}
        variant={roles.rowAction.variant}
        icon={<Icon icon={icons.use} size="sm" />}
        onClick={() => onUse(resource.id)}
      />
      <IconButton
        label={t("keys.row.revoke")}
        tooltip={t("keys.row.revoke")}
        size={roles.rowAction.size}
        variant={roles.rowAction.variant}
        icon={<Icon icon={icons.delete} size="sm" />}
        onClick={() => onRevoke(resource)}
      />
    </HStack>
  );
}

export function KeyTable({
  keys,
  onUse,
  onRevoke,
}: {
  keys: ClientKey[] | undefined;
  onUse: (id: string) => void;
  onRevoke: (resource: ClientKey) => void;
}) {
  const [shown, setShown] = useState<Record<string, Revealed | undefined>>({});
  const columns: TableColumn<Row>[] = [
    {
      key: "value",
      header: t("keys.table.key"),
      renderCell: loadingCell((resource: ClientKey) => (
        <Text type={roles.textType.identifier}>
          {shown[resource.id]?.rev === resource.rev ? shown[resource.id]?.key : resource.id}
        </Text>
      )),
    },
    {
      key: "actions",
      header: t("keys.table.actions"),
      align: "end",
      renderCell: ({ item }) =>
        item === null ? null : (
          <KeyActions
            key={`${item.id}:${item.rev}`}
            resource={item}
            shown={shown[item.id]?.rev === item.rev}
            onShow={(value) => setShown((was) => ({ ...was, [item.id]: value }))}
            onUse={onUse}
            onRevoke={onRevoke}
          />
        ),
    },
  ];
  return (
    <Table<Row>
      data={keys?.map((item) => ({ id: item.id, item })) ?? placeholderRows}
      columns={columns}
      idKey="id"
      density={roles.table.density}
      hasHover={keys !== undefined}
    />
  );
}
