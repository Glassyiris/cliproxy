// The Models view's table: one row per model of the chosen families, 20 to a page.
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Pagination } from "@astryxdesign/core/Pagination";
import {
  proportional,
  Table,
  useTableSortable,
  useTableSortableState,
  type TableColumn,
  type TableSortComparator,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Ellipsis } from "lucide-react";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { kilo, PAGE_SIZE, pageOf, type ModelRow } from "./modelConfig.ts";
import { useRowActivation } from "./rowActivation.ts";
import { SkeletonTable } from "./SkeletonTable.tsx";

export const share = (n: number) => proportional(n, { minWidth: layout.tableColumnFloor });

export type ModelActions = {
  onAlias: (row: ModelRow) => void;
  onExclude: (row: ModelRow) => void;
  onAllow: (row: ModelRow) => void;
};

/** The model ID in the identifier type with its copy button. */
export function ModelId({ id }: { id: string }) {
  const { copy, isCopied } = useClipboard({ announce: t("models.row.copied") });
  return (
    <HStack gap={1} vAlign="center">
      <Text type={roles.textType.identifier}>{id}</Text>
      <IconButton
        label={t("models.row.copy", { model: id })}
        tooltip={t("models.row.copyShort")}
        variant={roles.rowAction.variant}
        size={roles.rowAction.size}
        icon={<Icon icon={isCopied ? "check" : "copy"} size="sm" />}
        onClick={() => void copy(id)}
      />
    </HStack>
  );
}

export const statusOf = (row: ModelRow) =>
  row.excludedBy ? t("models.row.excluded") : t("models.row.available");

function Status({ row }: { row: ModelRow }) {
  return <StatusLamp status={row.excludedBy ? "disabled" : "ready"} label={statusOf(row)} />;
}

function RowMenu({ row, actions }: { row: ModelRow; actions: ModelActions }) {
  return (
    <DropdownMenu
      menuMaxHeight={layout.menuMaxHeight}
      button={{
        label: t("models.row.menu", { model: row.id }),
        variant: roles.rowAction.variant,
        size: roles.rowAction.size,
        icon: <Icon icon={Ellipsis} size="sm" />,
        isIconOnly: true,
      }}
      hasChevron={false}
      alignment="end"
      items={[
        { label: t("models.row.addAlias"), onClick: () => actions.onAlias(row) },
        row.excludedBy
          ? { label: t("models.row.allow"), onClick: () => actions.onAllow(row) }
          : { label: t("models.row.exclude"), onClick: () => actions.onExclude(row) },
      ]}
    />
  );
}

/** A token limit, `128k`; 0 is a limit the catalog does not state. */
export const limitText = (n: number) => (
  <Text hasTabularNumbers color={n > 0 ? "primary" : "secondary"}>
    {kilo(n) ?? t("models.panel.noLimit")}
  </Text>
);

// Sort the value, not the label: `128k` would sort below `32k` as text.
const comparators: Partial<Record<string, TableSortComparator<ModelRow>>> = {
  id: (a, b) => a.id.localeCompare(b.id),
  name: (a, b) => a.name.localeCompare(b.name),
  context: (a, b) => a.context - b.context,
  output: (a, b) => a.output - b.output,
};

const aliasText = (row: ModelRow) =>
  row.aliases.length ? (
    <Text type={roles.textType.identifier}>{row.aliases.join(", ")}</Text>
  ) : (
    <Text color="secondary">{t("models.row.noAlias")}</Text>
  );

function columnsFor(isMobile: boolean, actions: ModelActions): TableColumn<ModelRow>[] {
  const id: TableColumn<ModelRow> = {
    key: "id",
    width: share(3),
    header: t("models.col.model"),
    sortable: true,
    renderCell: (row) =>
      isMobile ? (
        <VStack gap={1}>
          <ModelId id={row.id} />
          <Text type={roles.textType.supporting} color="secondary">
            {t("models.row.summary", { family: label(row.channel), status: statusOf(row) })}
          </Text>
        </VStack>
      ) : (
        <ModelId id={row.id} />
      ),
  };
  const menu: TableColumn<ModelRow> = {
    key: "actions",
    header: t("models.col.actions"),
    align: "end",
    renderCell: (row) => <RowMenu row={row} actions={actions} />,
  };
  if (isMobile) return [id, menu];
  return [
    id,
    {
      key: "name",
      width: share(2),
      header: t("models.col.name"),
      sortable: true,
      renderCell: (row) => row.name,
    },
    {
      key: "channel",
      width: share(1),
      header: t("models.col.family"),
      renderCell: (row) => label(row.channel),
    },
    { key: "aliases", width: share(2), header: t("models.col.aliases"), renderCell: aliasText },
    {
      key: "status",
      width: share(1),
      header: t("models.col.status"),
      renderCell: (row) => <Status row={row} />,
    },
    {
      key: "context",
      width: share(1),
      header: t("models.panel.context"),
      align: "end",
      sortable: true,
      renderCell: (row) => limitText(row.context),
    },
    {
      key: "output",
      width: share(1),
      header: t("models.col.output"),
      align: "end",
      sortable: true,
      renderCell: (row) => limitText(row.output),
    },
    menu,
  ];
}

export function CatalogTable({
  rows,
  isFiltered,
  page,
  openKey,
  actions,
  onOpen,
  onPage,
  onClear,
}: {
  /** Undefined until the first catalog is read. */
  rows: ModelRow[] | undefined;
  isFiltered: boolean;
  page: number;
  openKey: string | undefined;
  actions: ModelActions;
  onOpen: (row: ModelRow) => void;
  onPage: (page: number) => void;
  onClear: () => void;
}) {
  const isMobile = useAppShellMobile().isMobile;
  const activation = useRowActivation<ModelRow>(openKey, onOpen);
  const columns = columnsFor(isMobile, actions);
  const { sortedData, sortConfig } = useTableSortableState<ModelRow>({
    data: rows ?? [],
    comparators,
  });
  const sort = useTableSortable<ModelRow>(sortConfig);
  if (!rows)
    return (
      <SkeletonTable
        headers={columns.map((c) => (typeof c.header === "string" ? c.header : c.key))}
      />
    );
  if (!rows.length)
    return isFiltered ? (
      <EmptyState
        title={t("models.empty.noMatch")}
        headingLevel={roles.heading.section}
        actions={<Button label={t("models.empty.clear")} variant="secondary" onClick={onClear} />}
      />
    ) : (
      <EmptyState
        title={t("models.empty.catalog")}
        description={t("models.empty.catalogHint")}
        headingLevel={roles.heading.section}
      />
    );
  const shown = pageOf(sortedData, page);
  return (
    <VStack gap={roles.gap.card}>
      <Table<ModelRow>
        data={shown.rows}
        columns={columns}
        idKey="key"
        density={roles.table.density}
        hasHover
        plugins={{ activation, sort }}
      />
      {rows.length > PAGE_SIZE && (
        <Pagination
          page={shown.page}
          onChange={onPage}
          totalItems={rows.length}
          pageSize={PAGE_SIZE}
          label={t("models.page.pages")}
        />
      )}
    </VStack>
  );
}
