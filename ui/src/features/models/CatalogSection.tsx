import { useMemo } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import {
  Table,
  useTableSortable,
  useTableSortableState,
  type TableColumn,
  type TableSortComparator,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ReadError } from "../../components/ReadError.tsx";
import { t } from "../../lib/i18n.ts";
import { kilo, matchesQuery, type CatalogRow } from "./modelConfig.ts";
import { Section } from "./Section.tsx";
import { SkeletonTable } from "./SkeletonTable.tsx";

// Sort the value, not the label: `128k` would sort below `32k` as text.
const comparators: Partial<Record<string, TableSortComparator<CatalogRow>>> = {
  id: (a, b) => a.id.localeCompare(b.id),
  name: (a, b) => a.name.localeCompare(b.name),
  context: (a, b) => a.context - b.context,
  output: (a, b) => a.output - b.output,
};

const limit = (n: number) => (
  <Text hasTabularNumbers color={n > 0 ? "primary" : "secondary"}>
    {kilo(n) ?? t("models.catalog.noLimit")}
  </Text>
);

const catalogColumns = (): TableColumn<CatalogRow>[] => [
  {
    key: "id",
    header: t("models.catalog.id"),
    sortable: true,
    renderCell: (row) => <Code>{row.id}</Code>,
  },
  { key: "name", header: t("models.catalog.name"), sortable: true },
  {
    key: "context",
    header: t("models.catalog.context"),
    align: "end",
    sortable: true,
    renderCell: (row) => limit(row.context),
  },
  {
    key: "output",
    header: t("models.catalog.output"),
    align: "end",
    sortable: true,
    renderCell: (row) => limit(row.output),
  },
];

function CatalogTable({ visible }: { visible: CatalogRow[] }) {
  const { sortedData, sortConfig } = useTableSortableState<CatalogRow>({
    data: visible,
    comparators,
  });
  const sort = useTableSortable<CatalogRow>(sortConfig);
  return (
    <Table<CatalogRow>
      data={sortedData}
      columns={catalogColumns()}
      idKey="id"
      hasHover
      plugins={{ sort }}
    />
  );
}

export function CatalogSection({
  channelName,
  rows,
  failure,
  query,
  onQuery,
}: {
  channelName: string;
  /** Undefined until the catalog is read. */
  rows: CatalogRow[] | undefined;
  failure?: { error: unknown; retry: () => void };
  query: string;
  onQuery: (query: string) => void;
}) {
  const visible = useMemo(() => rows?.filter((row) => matchesQuery(row, query)), [rows, query]);

  let body;
  if (failure)
    body = (
      <ReadError error={failure.error} what={t("models.catalog.what")} retry={failure.retry} />
    );
  else if (!visible)
    body = <SkeletonTable headers={catalogColumns().map((c) => c.header as string)} />;
  else if (!rows?.length)
    body = (
      <EmptyState title={t("models.catalog.empty", { channel: channelName })} headingLevel={3} />
    );
  else if (!visible.length)
    body = (
      <EmptyState
        title={t("models.catalog.noMatch")}
        headingLevel={3}
        actions={
          <Button
            label={t("models.catalog.clear")}
            variant="secondary"
            onClick={() => onQuery("")}
          />
        }
      />
    );
  else body = <CatalogTable visible={visible} />;

  return (
    <Section heading={t("models.catalog.title")}>
      <VStack gap={3}>
        {rows?.length ? (
          <TextInput
            label={t("models.catalog.search")}
            isLabelHidden
            placeholder={t("models.catalog.search")}
            value={query}
            onChange={onQuery}
            startIcon={<Icon icon="search" size="sm" />}
          />
        ) : null}
        {body}
      </VStack>
    </Section>
  );
}
