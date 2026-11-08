// The open model's facts in the detail panel, as table-grouped's TaskDetailPanel lists a task's:
// a MetadataList with the label column at the start, so every label keeps one gap to its value.
import { X } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";
import { limitText, ModelId, statusOf, type ModelActions } from "./CatalogTable.tsx";
import type { ModelRow } from "./modelConfig.ts";

export function ModelPanel({
  row,
  actions,
  onClose,
}: {
  row: ModelRow;
  actions: ModelActions;
  onClose: () => void;
}) {
  return (
    <VStack gap={roles.gap.card}>
      <HStack gap={2} vAlign="start">
        <StackItem size="fill">
          <Heading level={roles.heading.section}>{row.name || row.id}</Heading>
        </StackItem>
        <IconButton
          label={t("models.panel.close")}
          variant={roles.rowAction.variant}
          size={roles.rowAction.size}
          icon={<Icon icon={X} size="sm" />}
          onClick={onClose}
        />
      </HStack>
      <HStack gap={2} wrap="wrap">
        <Button
          label={t("models.row.addAlias")}
          variant="secondary"
          onClick={() => actions.onAlias(row)}
        />
        {row.excludedBy ? (
          <Button
            label={t("models.row.allow")}
            variant="secondary"
            onClick={() => actions.onAllow(row)}
          />
        ) : (
          <Button
            label={t("models.row.exclude")}
            variant="secondary"
            onClick={() => actions.onExclude(row)}
          />
        )}
      </HStack>
      <MetadataList label={{ position: "start" }}>
        <MetadataListItem label={t("models.col.model")}>
          <ModelId id={row.id} />
        </MetadataListItem>
        <MetadataListItem label={t("models.col.family")}>{label(row.channel)}</MetadataListItem>
        <MetadataListItem label={t("models.col.status")}>
          {row.excludedBy
            ? t("models.panel.excludedBy", { pattern: row.excludedBy })
            : statusOf(row)}
        </MetadataListItem>
        <MetadataListItem label={t("models.col.aliases")}>
          {row.aliases.length ? (
            <Text type={roles.textType.identifier}>{row.aliases.join(", ")}</Text>
          ) : (
            t("models.row.noAlias")
          )}
        </MetadataListItem>
        <MetadataListItem label={t("models.panel.context")}>
          {limitText(row.context)}
        </MetadataListItem>
        <MetadataListItem label={t("models.panel.output")}>
          {limitText(row.output)}
        </MetadataListItem>
      </MetadataList>
    </VStack>
  );
}
