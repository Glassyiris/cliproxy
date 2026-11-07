import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { toml } from "@astryxdesign/core/CodeBlock/languages/toml";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Heading, Text } from "@astryxdesign/core/Text";
import { mask } from "../../lib/client-keys.ts";
import { flag } from "../../lib/first-run.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { snippet, tools } from "../../lib/tool-setup.ts";
import type { Tool } from "./tool.ts";

export const toolSectionId = "use-tool";

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

/** Region 2: one tool's setup text with the key masked, and Copy with the full key. */
export function SetUpTool({
  tool,
  onTool,
  target,
  clientKey,
  model,
}: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  target: string;
  clientKey: string;
  model: string;
}) {
  const isMobile = useAppShellMobile().isMobile;
  const { copy, isCopied } = useClipboard();
  const modelId = model || "MODEL_ID";
  const copySetup = () =>
    void copy(snippet(tool, target, clientKey, modelId)).then((ok) => {
      if (!ok) return notify("error", t("use.tool.copyFailed"));
      notify("success", t("use.tool.copied"));
      flag.set("start-tool", "1");
    });
  return (
    <VStack gap={4} id={toolSectionId}>
      <Heading level={2}>{t("use.tool.heading")}</Heading>
      {isMobile ? (
        <Selector
          label={t("use.tool.label")}
          options={[...tools]}
          value={tool}
          onChange={(v) => onTool(v as Tool)}
        />
      ) : (
        <HStack>
          <SegmentedControl
            label={t("use.tool.label")}
            value={tool}
            onChange={(v) => onTool(v as Tool)}
          >
            {tools.map((name) => (
              <SegmentedControlItem key={name} value={name} label={name} />
            ))}
          </SegmentedControl>
        </HStack>
      )}
      <Card padding={3}>
        <HStack gap={2}>
          <Icon icon="info" size="sm" color="secondary" />
          <Text type="body" color="secondary">
            {note(tool)}
          </Text>
        </HStack>
      </Card>
      <CodeBlock
        code={snippet(tool, target, mask(clientKey), modelId)}
        language={language(tool)}
        hasCopyButton={false}
        isWrapped={isMobile}
        width="100%"
      />
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Button
          label={t("use.tool.copy")}
          variant="secondary"
          icon={<Icon icon={isCopied ? "check" : "copy"} />}
          onClick={copySetup}
        />
        <Text type="supporting" color="secondary">
          {t("use.tool.copyNote")}
        </Text>
      </HStack>
    </VStack>
  );
}
