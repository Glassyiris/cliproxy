// The key groups of the table-grouped template: one header row per provider family (a chevron,
// the family's name and its group count; the row toggles the family open and shut), then that
// family's groups. Each group row opens its keys in the detail panel; its menu holds the writes.
// The template composes its rows by hand with a colgroup whose widths ride on `style`; here the
// Table stays data-driven and a row plugin draws the header rows, so no inline style is needed.
import { useMemo, type KeyboardEvent, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Spinner } from "@astryxdesign/core/Spinner";
import {
  Table,
  TableCell,
  pixel,
  proportional,
  type TableColumn,
  type TablePlugin,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { colorVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import type { ListShape } from "../../components/listShape.ts";
import { RequestSparkline } from "../../components/RequestSparkline.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { familyName, type Family } from "../../components/keyFamilies.ts";
import { entryId, type Entry } from "./groups.ts";
import type { GroupAction } from "./useGroupWrites.ts";
import { statusOf } from "./words.ts";

const styles = stylex.create({
  // table-grouped `groupHeaderCell`: the muted band and the pointer, on the spanning cell.
  familyCell: {
    cursor: "pointer",
    backgroundColor: "var(--color-background-muted)",
    paddingBlock: spacingVars["--spacing-3"],
    paddingInline: spacingVars["--spacing-4"],
  },
  clickableRow: { cursor: "pointer" },
  activeRow: {
    backgroundColor: colorVars["--color-overlay-pressed"],
    "--table-row-overlay": colorVars["--color-overlay-pressed"],
  },
});

type FamilyItem = { kind: "family"; id: string; family: Family; count: number; isOpen: boolean };
type GroupItem = { kind: "group"; id: string; entry: Entry };
type Item = (FamilyItem | GroupItem) & Record<string, unknown>;

/** table-inbox `INTERACTIVE_WITHIN_ROW`: controls inside the row that are not the row. */
const isRowItself = (target: EventTarget | null) =>
  !(target as HTMLElement | null)?.closest('button, input, a, [role="menuitem"], [role="img"]');

function FamilyHeader({ item }: { item: FamilyItem }) {
  return (
    <HStack gap={2} vAlign="center">
      <Icon icon={item.isOpen ? ChevronDown : ChevronRight} size="sm" color="secondary" />
      <Text type={roles.textType.body} weight={roles.textWeight.strong}>
        {familyName(item.family)}
      </Text>
      <Badge variant="neutral" label={item.count} />
    </HStack>
  );
}

function GroupName({ entry }: { entry: Entry }) {
  return (
    <VStack gap={0.5}>
      <Text type={roles.textType.body} maxLines={1}>
        {entry.name}
      </Text>
      {/* Only a custom endpoint earns the line; the default would read the same on every row. */}
      {entry.group["base-url"] && (
        <Text type={roles.textType.identifier} color="secondary" maxLines={1}>
          {entry.group["base-url"]}
        </Text>
      )}
    </VStack>
  );
}

function Status({ entry }: { entry: Entry }) {
  const s = statusOf(entry);
  return <StatusLamp status={s.status} label={s.label} />;
}

function KeyCount({ entry }: { entry: Entry }) {
  const models = entry.group.models?.filter((m) => m.name).length ?? 0;
  return (
    <VStack gap={0.5}>
      <Text type={roles.textType.body} hasTabularNumbers>
        {t("providers.table.keys", { count: entry.keys.length })}
      </Text>
      {/* Only a model restriction earns the line, as the endpoint does in the name cell. */}
      {models > 0 && (
        <Text type={roles.textType.supporting} color="secondary">
          {t("providers.table.models", { count: models })}
        </Text>
      )}
    </VStack>
  );
}

function Requests({ entry, pending }: { entry: Entry; pending: boolean }) {
  if (pending)
    return <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />;
  if (!entry.traffic)
    return (
      <Text type={roles.textType.supporting} color="secondary">
        {t("app.quota.notReported")}
      </Text>
    );
  return <RequestSparkline buckets={entry.traffic} times={entry.traffic.times} />;
}

function GroupMenu({
  entry,
  saving,
  onAction,
}: {
  entry: Entry;
  saving: boolean;
  onAction: (action: GroupAction) => void;
}) {
  const { family, index } = entry;
  return (
    <MoreMenu
      label={t("providers.group.menu", { name: entry.name })}
      size={roles.rowAction.size}
      alignment="end"
      icon={saving ? <Spinner size="sm" aria-label={t("providers.group.saving")} /> : undefined}
      items={[
        ...(family === "openai-compatibility"
          ? [
              {
                label: entry.group.disabled
                  ? t("providers.group.enable")
                  : t("providers.group.disable"),
                onClick: () => onAction({ kind: "toggle", family, index }),
              },
            ]
          : []),
        {
          label: t("providers.group.delete"),
          variant: "destructive" as const,
          onClick: () => onAction({ kind: "delete", family, index }),
        },
      ]}
    />
  );
}

/** The phone's summary cell: the name, then its state, keys and requests. */
function Summary({ entry, pending }: { entry: Entry; pending: boolean }) {
  return (
    <VStack gap={1}>
      <GroupName entry={entry} />
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Status entry={entry} />
        <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
          {t("providers.table.keys", { count: entry.keys.length })}
        </Text>
      </HStack>
      <Requests entry={entry} pending={pending} />
    </VStack>
  );
}

type TableProps = {
  sections: [Family, Entry[]][];
  collapsed: ReadonlySet<Family>;
  onToggleFamily: (family: Family) => void;
  openId: string;
  onOpen: (entry: Entry) => void;
  trafficPending: boolean;
  toggling: string | null;
  onAction: (action: GroupAction) => void;
  shape: ListShape;
};

const share = (n: number) => proportional(n, { minWidth: layout.tableColumnFloor });

function columnsOf(props: TableProps): TableColumn<Item>[] {
  const cell = (render: (e: Entry) => ReactNode) => (item: Item) =>
    item.kind === "group" ? render(item.entry) : null;
  const menu: TableColumn<Item> = {
    key: "actions",
    header: "",
    width: pixel(layout.tableColumnFloor),
    align: "end",
    renderCell: cell((e) => (
      <GroupMenu entry={e} saving={props.toggling === entryId(e)} onAction={props.onAction} />
    )),
  };
  const name = t("providers.table.group");
  if (props.shape === "stacked")
    return [
      {
        key: "group",
        header: name,
        width: share(1),
        renderCell: cell((e) => <Summary entry={e} pending={props.trafficPending} />),
      },
      menu,
    ];
  const columns: TableColumn<Item>[] = [
    {
      key: "group",
      header: name,
      width: share(2),
      renderCell: cell((e) => <GroupName entry={e} />),
    },
    {
      key: "status",
      header: t("providers.table.status"),
      width: share(1.25),
      renderCell: cell((e) => <Status entry={e} />),
    },
    {
      key: "keys",
      header: t("providers.table.key"),
      width: share(1),
      renderCell: cell((e) => <KeyCount entry={e} />),
    },
  ];
  if (props.shape === "wide")
    columns.push({
      key: "requests",
      header: t("providers.table.requests"),
      width: pixel(layout.requests.column),
      renderCell: cell((e) => <Requests entry={e} pending={props.trafficPending} />),
    });
  return [...columns, menu];
}

const activate = (event: KeyboardEvent, run: () => void) => {
  if ((event.key !== "Enter" && event.key !== " ") || !isRowItself(event.target)) return;
  event.preventDefault();
  run();
};

function useRowPlugin({ openId, onOpen, onToggleFamily }: TableProps) {
  return useMemo<TablePlugin<Item>>(
    () => ({
      transformBodyRow: (props, item) => {
        if (item.kind === "family")
          return {
            ...props,
            htmlProps: {
              ...props.htmlProps,
              "data-group-row": item.family,
              tabIndex: 0,
              "aria-expanded": item.isOpen,
              onClick: () => onToggleFamily(item.family),
              onKeyDown: (event) => activate(event, () => onToggleFamily(item.family)),
            },
            children: (
              <TableCell colSpan={999} xstyle={styles.familyCell}>
                <FamilyHeader item={item} />
              </TableCell>
            ),
          };
        const isOpen = item.id === openId;
        return {
          ...props,
          htmlProps: {
            ...props.htmlProps,
            tabIndex: 0,
            "aria-current": isOpen ? true : undefined,
            onClick: (event) => isRowItself(event.target) && onOpen(item.entry),
            onKeyDown: (event) => activate(event, () => onOpen(item.entry)),
          },
          xstyle: props.xstyle.concat(
            isOpen ? [styles.clickableRow, styles.activeRow] : styles.clickableRow,
          ),
        };
      },
    }),
    [openId, onOpen, onToggleFamily],
  );
}

export function ProviderTable(props: TableProps) {
  const { sections, collapsed } = props;
  const items = useMemo(
    () =>
      sections.flatMap(([family, entries]): Item[] => {
        const isOpen = !collapsed.has(family);
        const header: Item = { kind: "family", id: family, family, count: entries.length, isOpen };
        if (!isOpen) return [header];
        return [
          header,
          ...entries.map((entry): Item => ({ kind: "group", id: entryId(entry), entry })),
        ];
      }),
    [sections, collapsed],
  );
  const plugin = useRowPlugin(props);
  const plugins = useMemo(() => ({ rows: plugin }), [plugin]);
  return (
    <Table<Item>
      data={items}
      columns={columnsOf(props)}
      idKey="id"
      density={roles.table.density}
      dividers="rows"
      hasHover
      plugins={plugins}
    />
  );
}

const skeletonRows = ["a", "b", "c", "d"].map((key) => ({ key }));

/** The table's shape while the config loads. */
export function ProviderTableSkeleton() {
  const cell = () => (
    <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
  );
  const columns: TableColumn<{ key: string }>[] = [
    { key: "group", header: t("providers.table.group"), width: share(2), renderCell: cell },
    { key: "status", header: t("providers.table.status"), width: share(1.25), renderCell: cell },
    { key: "keys", header: t("providers.table.key"), width: share(1), renderCell: cell },
  ];
  return (
    <VStack gap={0} aria-busy aria-label={t("providers.page.loading")}>
      <Table
        data={skeletonRows}
        columns={columns}
        idKey="key"
        density={roles.table.density}
        dividers="rows"
      />
    </VStack>
  );
}
