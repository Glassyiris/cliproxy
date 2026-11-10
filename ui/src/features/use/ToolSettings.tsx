import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { toml } from "@astryxdesign/core/CodeBlock/languages/toml";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import type { ClientKey } from "../../lib/api/clientKeys.ts";
import { isUsableSecret } from "../../lib/api/config.ts";
import { mask } from "../../lib/clientKeys.ts";
import { flag } from "../../lib/firstRun.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { snippet } from "../../lib/toolSetup.ts";
import { roles } from "../../themes/site/roles.ts";
import type { Tool } from "./tool.ts";
import type { KeyChoice } from "./useKeyChoice.ts";

/** What the setup text itself does not say; Codex CLI's comments say it all. */
function note(tool: Tool) {
  switch (tool) {
    case "Claude Code":
      return t("use.note.claudeCode");
    case "Codex CLI":
      return undefined;
    case "Cursor":
      return t("use.note.cursor");
    case "OpenAI SDK":
      return t("use.note.openaiSdk");
    case "Anthropic SDK":
      return t("use.note.anthropicSdk");
    case "curl":
      return t("use.note.curl");
  }
}

const language = (tool: Tool) => {
  switch (tool) {
    case "Codex CLI":
      return toml;
    case "OpenAI SDK":
    case "Anthropic SDK":
      return "python";
    case "Cursor":
      return "plaintext";
    default:
      return "bash";
  }
};

function modelHint(choice: KeyChoice) {
  if (!choice.key) return undefined;
  if (choice.checking) return t("use.settings.checking");
  if (choice.failed) return t("use.settings.modelsFailed");
  if (!choice.models.length) return t("use.settings.noModels");
  return undefined;
}

function SettingsSelectors({
  keys,
  choice,
  onKey,
  isMobile,
}: {
  keys: ClientKey[] | undefined;
  choice: KeyChoice;
  onKey: (id: string) => void;
  isMobile: boolean;
}) {
  return (
    <FormLayout direction={isMobile ? "vertical" : "horizontal"} defaultOptionality="optional">
      <Selector
        label={t("use.settings.key")}
        options={(keys ?? []).map((resource) => ({ value: resource.id, label: resource.id }))}
        value={choice.id}
        isLoading={!keys}
        onChange={onKey}
      />
      <Selector
        label={t("use.settings.model")}
        options={choice.models}
        value={choice.model || undefined}
        isLoading={choice.checking}
        description={modelHint(choice)}
        onChange={choice.onModel}
      />
    </FormLayout>
  );
}

/** Step 2 keeps the selected resource ID separate from explicitly revealed plaintext. */
export function ToolSettings({
  tool,
  target,
  keys,
  choice,
  onKey,
  local,
}: {
  tool: Tool;
  target: string;
  /** Undefined while resources load. */
  keys: ClientKey[] | undefined;
  choice: KeyChoice;
  onKey: (id: string) => void;
  local: boolean;
}) {
  const isMobile = useAppShellMobile().isMobile;
  const { copy, isCopied } = useClipboard();
  const modelId = choice.model || "MODEL_ID";
  const copySetup = async () => {
    const key = await choice.reveal();
    if (!isUsableSecret(key)) return;
    const ok = await copy(snippet(tool, target, key, modelId));
    if (!ok) return notify("error", t("use.settings.copyFailed"));
    notify("success", t("use.settings.copied"));
    flag.set("start-tool", "1");
  };
  return (
    <FormLayout defaultOptionality="optional">
      <SettingsSelectors keys={keys} choice={choice} onKey={onKey} isMobile={isMobile} />
      {local && (
        <Banner
          status="warning"
          title={t("use.settings.localTitle")}
          description={t("use.settings.localDescription")}
        />
      )}
      <CodeBlock
        code={snippet(tool, target, mask(choice.key), modelId)}
        language={language(tool)}
        hasCopyButton={false}
        isWrapped={isMobile}
        width="100%"
      />
      <HStack gap={3} vAlign="center" wrap="wrap">
        {!choice.key && (
          <Button
            label={t("keys.row.show")}
            variant="secondary"
            isLoading={choice.revealing}
            onClick={() => void choice.reveal()}
          />
        )}
        <Button
          label={t("use.settings.copy")}
          variant="secondary"
          icon={<Icon icon={isCopied ? "check" : "copy"} />}
          onClick={() => void copySetup()}
        />
        <Text type={roles.textType.supporting} color="secondary">
          {t("use.settings.copyNote")}
        </Text>
      </HStack>
      {note(tool) && (
        <Text type={roles.textType.supporting} color="secondary">
          {note(tool)}
        </Text>
      )}
    </FormLayout>
  );
}
