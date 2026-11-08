// The table-grouped body: one group per model name, its header a full-width row that folds the
// group, then one row per rule (model pattern, action, number of fields, remove).
import { icons } from "../../components/icons.ts";
import { providerIcon } from "../../components/ProviderIcon.tsx";
import { rowStyles } from "../../components/rowStyles.ts";
import { label } from "../../lib/credentials.ts";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Badge } from "@astryxdesign/core/Badge";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { fieldCount, NO_MODEL, UNREADABLE, type RuleRow } from "./rules.ts";

export type RuleGroup = { name: string; rows: RuleRow[] };

const styles = stylex.create({
  // table-grouped:66-70: the group header fills the row with the muted background.
  groupHeader: { cursor: "pointer", backgroundColor: colorVars["--color-background-muted"] },
});

export const groupName = (name: string) => {
  if (name === NO_MODEL) return t("payload.group.noModels");
  if (name === UNREADABLE) return t("payload.row.unreadable");
  return name;
};

export const fieldsOf = (row: RuleRow) => fieldCount(row.rule ? row.rule.params : row.entry);

/** Activates on Enter or Space when the row itself has focus (table-filter:2754-2762). */
const onActivate = (run: () => void) => (event: KeyboardEvent<HTMLTableRowElement>) => {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  run();
};

/** Takes focus when `focused` turns true: the row that moved up into a removed rule's place. */
function RemoveButton({ focused, onRemove }: { focused: boolean; onRemove: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focused) ref.current?.focus();
  }, [focused]);
  return (
    <IconButton
      ref={ref}
      label={t("payload.row.remove")}
      tooltip={t("payload.row.remove")}
      variant={roles.rowAction.variant}
      size={roles.rowAction.size}
      icon={<Icon icon={icons.delete} size="sm" />}
      onClick={onRemove}
    />
  );
}

function Pattern({ row, isMobile }: { row: RuleRow; isMobile: boolean }) {
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text type={roles.textType.identifier}>
          {row.model ? row.model.name : groupName(row.rule ? NO_MODEL : UNREADABLE)}
        </Text>
        {row.model?.protocol && (
          <Token
            label={label(row.model.protocol)}
            icon={<Icon icon={providerIcon(row.model.protocol)} size="xsm" />}
            size="sm"
          />
        )}
      </HStack>
      {isMobile && (
        <Text type={roles.textType.supporting} color="secondary">
          {t("payload.row.summary", { kind: row.kind, count: fieldsOf(row) })}
        </Text>
      )}
    </VStack>
  );
}

type RowProps = {
  row: RuleRow;
  isMobile: boolean;
  isOpen: boolean;
  focused: boolean;
  onOpen: () => void;
  onRemove: () => void;
};

function RuleRowView({ row, isMobile, isOpen, focused, onOpen, onRemove }: RowProps) {
  return (
    <TableRow
      tabIndex={0}
      aria-current={isOpen ? true : undefined}
      xstyle={[rowStyles.clickableRow, isOpen && rowStyles.activeRow]}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, a")) return;
        onOpen();
      }}
      onKeyDown={onActivate(onOpen)}
    >
      <TableCell>
        <Pattern row={row} isMobile={isMobile} />
      </TableCell>
      {!isMobile && (
        <TableCell>
          <Text type={roles.textType.identifier}>{row.kind}</Text>
        </TableCell>
      )}
      {!isMobile && (
        <TableCell>
          <HStack hAlign="end">
            <Text hasTabularNumbers>{fieldsOf(row)}</Text>
          </HStack>
        </TableCell>
      )}
      <TableCell>
        <HStack hAlign="end">
          <RemoveButton focused={focused} onRemove={onRemove} />
        </HStack>
      </TableCell>
    </TableRow>
  );
}

function GroupHeader({
  group,
  open,
  span,
  onToggle,
}: {
  group: RuleGroup;
  open: boolean;
  span: number;
  onToggle: () => void;
}) {
  return (
    <TableRow
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={onActivate(onToggle)}
    >
      <TableCell colSpan={span} xstyle={styles.groupHeader}>
        <HStack gap={2} vAlign="center">
          <Icon icon={open ? "chevronDown" : "chevronRight"} size="sm" color="secondary" />
          <Text type={roles.textType.identifier} weight={roles.textWeight.strong}>
            {groupName(group.name)}
          </Text>
          <Badge variant="neutral" label={String(group.rows.length)} />
        </HStack>
      </TableCell>
    </TableRow>
  );
}

type Column = { key: string; header: string; isEnd?: boolean };

const columnsFor = (isMobile: boolean): Column[] => [
  { key: "pattern", header: t("payload.col.pattern") },
  ...(isMobile
    ? []
    : [
        { key: "kind", header: t("payload.col.kind") },
        { key: "fields", header: t("payload.col.fields"), isEnd: true },
      ]),
  { key: "actions", header: t("payload.col.actions"), isEnd: true },
];

/** The column headings; the grouped body is hand-built rows, so the Table draws none itself. */
function Header({ columns }: { columns: Column[] }) {
  return (
    <TableHeader>
      <TableRow isHeaderRow>
        {columns.map((column) => (
          <TableHeaderCell key={column.key} scope="col">
            {column.isEnd ? <HStack hAlign="end">{column.header}</HStack> : column.header}
          </TableHeaderCell>
        ))}
      </TableRow>
    </TableHeader>
  );
}

function SkeletonRows({ span }: { span: number }) {
  return ["a", "b", "c", "d"].map((id) => (
    <TableRow key={id} aria-hidden>
      <TableCell colSpan={span}>
        <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
      </TableCell>
    </TableRow>
  ));
}

export function RuleTable({
  groups,
  openKey,
  focus,
  onOpen,
  onRemove,
}: {
  /** Undefined while the config loads. */
  groups: RuleGroup[] | undefined;
  openKey: string | undefined;
  /** `<kind>:<index>` of the Remove button that should hold focus, if any. */
  focus: string | null;
  onOpen: (row: RuleRow) => void;
  onRemove: (row: RuleRow) => void;
}) {
  const isMobile = useAppShellMobile().isMobile;
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const columns = columnsFor(isMobile);
  const toggle = (name: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  return (
    <Table density={roles.table.density} dividers="rows" hasHover={!!groups}>
      <Header columns={columns} />
      <TableBody>
        {groups ? (
          groups.map((group) => (
            <Fragment key={group.name}>
              <GroupHeader
                group={group}
                open={!folded.has(group.name)}
                span={columns.length}
                onToggle={() => toggle(group.name)}
              />
              {!folded.has(group.name) &&
                group.rows.map((row) => (
                  <RuleRowView
                    key={row.key}
                    row={row}
                    isMobile={isMobile}
                    isOpen={row.key === openKey}
                    focused={row.key === focus}
                    onOpen={() => onOpen(row)}
                    onRemove={() => onRemove(row)}
                  />
                ))}
            </Fragment>
          ))
        ) : (
          <SkeletonRows span={columns.length} />
        )}
      </TableBody>
    </Table>
  );
}
