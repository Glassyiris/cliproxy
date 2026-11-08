// The Rules view: the aliases and exclusion patterns of the chosen families, each removable after
// a confirmation; focus then goes to the row that took the removed one's place.
import type { RefObject } from "react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Pagination } from "@astryxdesign/core/Pagination";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { icons } from "../../components/icons.ts";
import { ProviderLabel } from "../../components/ProviderIcon.tsx";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { PAGE_SIZE, pageOf, type RuleRow } from "./modelConfig.ts";
import { providerShare, share } from "./CatalogTable.tsx";
import { SkeletonTable } from "./SkeletonTable.tsx";
import { useRemovalFocus } from "./useRemovalFocus.ts";

const kindWord = (row: RuleRow) =>
  row.kind === "alias" ? t("models.rules.alias") : t("models.rules.excluded");

function Target({ row }: { row: RuleRow }) {
  if (row.kind === "excluded") return <Text color="secondary">{t("models.rules.hidden")}</Text>;
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <Text type={roles.textType.identifier}>{row.alias}</Text>
      {row.fork && <Token label={t("models.rules.keepsOriginal")} size="sm" />}
    </HStack>
  );
}

function columnsFor(
  isMobile: boolean,
  remove: (row: RuleRow, position: number) => void,
  bind: (position: number) => (el: HTMLButtonElement | null) => void,
  rows: RuleRow[],
): TableColumn<RuleRow>[] {
  const pattern: TableColumn<RuleRow> = {
    key: "pattern",
    width: share(3),
    header: t("models.col.pattern"),
    renderCell: (row) => (
      <VStack gap={1}>
        <Text type={roles.textType.identifier}>{row.pattern}</Text>
        {isMobile && (
          <Text type={roles.textType.supporting} color="secondary">
            {t("models.row.summary", { family: label(row.channel), status: kindWord(row) })}
          </Text>
        )}
      </VStack>
    ),
  };
  const action: TableColumn<RuleRow> = {
    key: "actions",
    header: t("models.col.actions"),
    align: "end",
    renderCell: (row) => {
      const position = rows.indexOf(row);
      const name = row.kind === "alias" ? (row.alias ?? "") : row.pattern;
      return (
        <IconButton
          ref={bind(position)}
          label={t("models.rules.removeNamed", { rule: name })}
          tooltip={t("models.rules.remove")}
          variant={roles.rowAction.variant}
          size={roles.rowAction.size}
          icon={<Icon icon={icons.delete} size="sm" />}
          onClick={() => remove(row, position)}
        />
      );
    },
  };
  if (isMobile)
    return [
      pattern,
      { key: "target", header: t("models.col.target"), renderCell: (row) => <Target row={row} /> },
      action,
    ];
  return [
    { key: "kind", width: share(1), header: t("models.col.rule"), renderCell: kindWord },
    pattern,
    {
      key: "target",
      width: share(2),
      header: t("models.col.target"),
      renderCell: (row) => <Target row={row} />,
    },
    {
      key: "channel",
      width: providerShare,
      header: t("models.col.family"),
      renderCell: (row) => (
        <ProviderLabel provider={row.channel} color="secondary">
          <Text maxLines={1}>{label(row.channel)}</Text>
        </ProviderLabel>
      ),
    },
    action,
  ];
}

export function RulesTable({
  rows,
  isFiltered,
  page,
  fallback,
  onRemove,
  onPage,
  onClear,
}: {
  rows: RuleRow[] | undefined;
  isFiltered: boolean;
  page: number;
  /** Where focus goes when the last rule is removed. */
  fallback: RefObject<HTMLButtonElement | null>;
  /** Asks first; resolves true when the rule was removed. */
  onRemove: (row: RuleRow) => Promise<boolean>;
  onPage: (page: number) => void;
  onClear: () => void;
}) {
  const isMobile = useAppShellMobile().isMobile;
  const shown = rows ? pageOf(rows, page) : undefined;
  const removal = useRemovalFocus(shown?.rows.length, () => fallback.current);
  const remove = (row: RuleRow, position: number) =>
    void removal.run(position, () => onRemove(row));
  const columns = columnsFor(isMobile, remove, removal.bind, shown?.rows ?? []);
  if (!rows || !shown)
    return (
      <SkeletonTable
        headers={columns.map((c) => (typeof c.header === "string" ? c.header : c.key))}
      />
    );
  if (!rows.length)
    return isFiltered ? (
      <EmptyState
        icon={<Icon icon={icons.search} size="lg" />}
        title={t("models.empty.noRuleMatch")}
        headingLevel={roles.heading.section}
        actions={<Button label={t("models.empty.clear")} variant="secondary" onClick={onClear} />}
      />
    ) : (
      <EmptyState
        icon={<Icon icon={icons.models} size="lg" />}
        title={t("models.empty.rules")}
        headingLevel={roles.heading.section}
      />
    );
  return (
    <VStack gap={roles.gap.card}>
      <Table<RuleRow>
        data={shown.rows}
        columns={columns}
        idKey="key"
        density={roles.table.density}
        hasHover
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
