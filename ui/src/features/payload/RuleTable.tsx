import { useEffect, useRef, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, TableBody, TableCell, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { isRule, modelLabels, type Kind, type Rule } from "./rules.ts";
import { kindMeaning } from "./words.ts";

/** `notList`: the server holds something other than a list for this kind. */
export type Group = { kind: Kind; entries: unknown[]; notList: boolean };

// Past this many lines a rule's parameters start folded.
const FOLD_LINES = 6;

// One column: a rule is its models and Remove button over its parameters, so the parameters take
// the table's whole width at every viewport.
const COLUMNS = 1;

function Models({ rule }: { rule: Rule }) {
  return (
    <HStack gap={2} wrap="wrap">
      {modelLabels(rule).map((label, i) => (
        <Code key={i}>{label}</Code>
      ))}
    </HStack>
  );
}

function Params({ params }: { params: unknown }) {
  const code = JSON.stringify(params, null, 2) ?? "null";
  const lines = code.split("\n").length;
  const block = (
    <CodeBlock code={code} language="json" hasLanguageLabel={false} isWrapped width="100%" />
  );
  if (lines <= FOLD_LINES) return block;
  return (
    <Collapsible
      defaultIsOpen={false}
      chevronPosition="start"
      trigger={
        <Text type="supporting" color="secondary">
          {t("payload.row.showParams", { count: lines })}
        </Text>
      }
    >
      {block}
    </Collapsible>
  );
}

/** Takes focus when `focused` turns true: the row that moved up into a removed rule's place. */
function RemoveButton({ focused, onRemove }: { focused: boolean; onRemove: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focused) ref.current?.focus();
  }, [focused]);
  return (
    <Button
      ref={ref}
      label={t("payload.row.remove")}
      variant="secondary"
      size="sm"
      onClick={onRemove}
    />
  );
}

function RuleRow({
  entry,
  focused,
  onRemove,
}: {
  entry: unknown;
  focused: boolean;
  onRemove: () => void;
}) {
  const rule = isRule(entry) ? entry : null;
  return (
    <TableRow>
      <TableCell>
        <VStack gap={2}>
          <HStack gap={2} vAlign="center">
            <StackItem size="fill">
              {rule ? (
                <Models rule={rule} />
              ) : (
                <Text type="supporting" color="secondary">
                  {t("payload.row.unreadable")}
                </Text>
              )}
            </StackItem>
            <RemoveButton focused={focused} onRemove={onRemove} />
          </HStack>
          <Params params={rule ? rule.params : entry} />
        </VStack>
      </TableCell>
    </TableRow>
  );
}

function GroupRows({
  group,
  open,
  focus,
  onToggle,
  onRemove,
}: {
  group: Group;
  open: boolean;
  focus: string | null;
  onToggle: () => void;
  onRemove: (index: number) => void;
}) {
  const label = open
    ? t("payload.row.fold", { kind: group.kind })
    : t("payload.row.unfold", { kind: group.kind });
  return (
    <>
      <TableRow>
        <TableCell colSpan={COLUMNS}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Button
              label={label}
              tooltip={label}
              variant="ghost"
              size="sm"
              isIconOnly
              aria-expanded={open}
              icon={<Icon icon={open ? "chevronDown" : "chevronRight"} size="sm" />}
              onClick={onToggle}
            />
            <Code>{group.kind}</Code>
            <Badge variant="neutral" label={group.entries.length} />
            <Text type="supporting" color="secondary">
              {kindMeaning(group.kind)}
            </Text>
          </HStack>
        </TableCell>
      </TableRow>
      {open && group.notList && (
        <TableRow>
          <TableCell colSpan={COLUMNS}>
            <Text type="supporting" color="secondary">
              {t("payload.group.storedNotList")}{" "}
              <Link href="#config">{t("payload.page.editLink")}</Link>
            </Text>
          </TableCell>
        </TableRow>
      )}
      {open && !group.notList && group.entries.length === 0 && (
        <TableRow>
          <TableCell colSpan={COLUMNS}>
            <Text type="supporting" color="secondary">
              {t("payload.group.empty", { kind: group.kind })}
            </Text>
          </TableCell>
        </TableRow>
      )}
      {open &&
        group.entries.map((entry, index) => (
          <RuleRow
            key={index}
            entry={entry}
            focused={focus === `${group.kind}:${index}`}
            onRemove={() => onRemove(index)}
          />
        ))}
    </>
  );
}

function SkeletonRows() {
  return (
    <>
      {["a", "b", "c"].map((id) => (
        <TableRow key={id}>
          <TableCell colSpan={COLUMNS}>
            <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

/** The five kinds as groups. `groups` is undefined while the config loads. */
export function RuleTable({
  groups,
  focus,
  onRemove,
}: {
  groups: Group[] | undefined;
  /** `<kind>:<index>` of the Remove button that should hold focus, if any. */
  focus: string | null;
  onRemove: (kind: Kind, index: number) => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<Kind>>(new Set());
  const toggle = (kind: Kind) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });
  return (
    <Table hasHover={!!groups}>
      <TableBody>
        {groups ? (
          groups.map((group) => (
            <GroupRows
              key={group.kind}
              group={group}
              open={!folded.has(group.kind)}
              focus={focus}
              onToggle={() => toggle(group.kind)}
              onRemove={(index) => onRemove(group.kind, index)}
            />
          ))
        ) : (
          <SkeletonRows />
        )}
      </TableBody>
    </Table>
  );
}
