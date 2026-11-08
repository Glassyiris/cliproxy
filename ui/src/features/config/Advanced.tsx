import { VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { Action } from "../../app/useAction.ts";
import { InlineConfigEditor } from "../../components/ConfigEditor.tsx";
import { t } from "../../lib/i18n.ts";

/** The whole file as YAML: everything the controls above do not cover stays editable here. */
export function Advanced({ action }: { action: Action }) {
  return (
    <VStack gap={4} paddingBlock={4}>
      <VStack gap={0}>
        <Text type="body" weight="semibold">
          {t("config.yaml.label")}
        </Text>
        <Text type="supporting" color="secondary">
          {t("config.yaml.hint")}
        </Text>
      </VStack>
      <InlineConfigEditor source={{ yaml: true }} title={t("config.yaml.label")} action={action} />
    </VStack>
  );
}
