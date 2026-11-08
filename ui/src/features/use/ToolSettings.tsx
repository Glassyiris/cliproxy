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
import { mask } from "../../lib/client-keys.ts";
import { flag } from "../../lib/first-run.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { snippet } from "../../lib/tool-setup.ts";
import { roles } from "../../themes/site/roles.ts";
import type { Tool } from "./tool.ts";
import type { KeyChoice } from "./useKeyChoice.ts";

function note(tool: Tool) {
  switch (tool) {
    case "Claude Code":
      return t("use.note.claudeCode");
    case "Codex CLI":
      return t("use.note.codexCli");
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
  if (choice.checking) return t("use.settings.checking");
  if (choice.failed) return t("use.settings.modelsFailed");
  if (!choice.models.length) return t("use.settings.noModels");
  return t("use.settings.modelCount", { count: choice.models.length });
}

/**
 * Step 2: the key and model, then the tool's setup text with the key masked, and Copy with the
 * full key. Both selectors stay mounted through a key change; the model list of the previous key
 * stays until the new one answers, marked as checking.
 */
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
  /** Undefined while the config loads. */
  keys: string[] | undefined;
  choice: KeyChoice;
  onKey: (index: number) => void;
  local: boolean;
}) {
  const isMobile = useAppShellMobile().isMobile;
  const { copy, isCopied } = useClipboard();
  const modelId = choice.model || "MODEL_ID";
  const copySetup = () =>
    void copy(snippet(tool, target, choice.key, modelId)).then((ok) => {
      if (!ok) return notify("error", t("use.settings.copyFailed"));
      notify("success", t("use.settings.copied"));
      flag.set("start-tool", "1");
    });
  return (
    <FormLayout defaultOptionality="optional">
      <FormLayout direction={isMobile ? "vertical" : "horizontal"} defaultOptionality="optional">
        <Selector
          label={t("use.settings.key")}
          options={(keys ?? []).map((key, i) => ({ value: String(i), label: mask(key) }))}
          value={keys ? String(choice.index) : undefined}
          isLoading={!keys}
          description={t("use.settings.keyHint")}
          onChange={(value) => onKey(Number(value))}
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
        <Button
          label={t("use.settings.copy")}
          variant="secondary"
          icon={<Icon icon={isCopied ? "check" : "copy"} />}
          onClick={copySetup}
        />
        <Text type={roles.textType.supporting} color="secondary">
          {t("use.settings.copyNote")}
        </Text>
      </HStack>
      <Text type={roles.textType.supporting} color="secondary">
        {note(tool)}
      </Text>
    </FormLayout>
  );
}
