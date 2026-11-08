// The open rule in the detail panel, as table-grouped's TaskDetailPanel: facts in a MetadataList,
// then the rule's JSON read-only in a CodeBlock. Editing stays in Settings' config editor so
// every change goes through its review and reread-and-compare.
import { X } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { icons } from "../../components/icons.ts";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { fieldsOf } from "./RuleTable.tsx";
import { modelsOf, type RuleRow } from "./rules.ts";
import { entryLabel, kindMeaning, modelWord } from "./words.ts";

export function RulePanel({
  row,
  onRemove,
  onClose,
}: {
  row: RuleRow;
  onRemove: () => void;
  onClose: () => void;
}) {
  const code = JSON.stringify(row.entry, null, 2) ?? "null";
  const models = row.rule ? modelsOf(row.rule) : [];
  return (
    <VStack gap={roles.gap.card}>
      <HStack gap={2} vAlign="start">
        <StackItem size="fill">
          <Heading level={roles.heading.section}>{entryLabel(row.entry)}</Heading>
        </StackItem>
        <IconButton
          label={t("payload.panel.close")}
          variant={roles.rowAction.variant}
          size={roles.rowAction.size}
          icon={<Icon icon={X} size="sm" />}
          onClick={onClose}
        />
      </HStack>
      <HStack gap={2} wrap="wrap">
        <Button
          label={t("payload.row.remove")}
          variant="secondary"
          icon={<Icon icon={icons.delete} />}
          onClick={onRemove}
        />
      </HStack>
      <MetadataList label={{ position: "start" }}>
        <MetadataListItem label={t("payload.col.kind")}>
          <VStack gap={1}>
            <Text type={roles.textType.identifier}>{row.kind}</Text>
            <Text type={roles.textType.supporting} color="secondary">
              {kindMeaning(row.kind)}
            </Text>
          </VStack>
        </MetadataListItem>
        <MetadataListItem label={t("payload.panel.models")}>
          {models.length ? (
            <Text type={roles.textType.identifier}>{models.map(modelWord).join(", ")}</Text>
          ) : (
            t("payload.row.noModels")
          )}
        </MetadataListItem>
        <MetadataListItem label={t("payload.col.fields")}>
          <Text hasTabularNumbers>{fieldsOf(row)}</Text>
        </MetadataListItem>
      </MetadataList>
      <CodeBlock code={code} language="json" hasLanguageLabel={false} isWrapped width="100%" />
      <Text type={roles.textType.supporting} color="secondary">
        {t("payload.panel.editHint")}
      </Text>
    </VStack>
  );
}
