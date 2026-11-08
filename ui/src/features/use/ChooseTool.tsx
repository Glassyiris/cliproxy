import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { t } from "../../lib/i18n.ts";
import { tools } from "../../lib/tool-setup.ts";
import type { Tool } from "./tool.ts";

/** A line only where the name leaves something to know before choosing. */
function summary(tool: Tool) {
  switch (tool) {
    case "Claude Code":
    case "Codex CLI":
    case "curl":
      return undefined;
    case "Cursor":
      return t("use.choose.cursor");
    case "OpenAI SDK":
      return t("use.choose.openaiSdk");
    case "Anthropic SDK":
      return t("use.choose.anthropicSdk");
  }
}

/** Step 1: which tool to set up. */
export function ChooseTool({ tool, onTool }: { tool: Tool; onTool: (tool: Tool) => void }) {
  return (
    <RadioList label={t("use.choose.label")} value={tool} onChange={(v) => onTool(v as Tool)}>
      {tools.map((name) => (
        <RadioListItem key={name} value={name} label={name} description={summary(name)} />
      ))}
    </RadioList>
  );
}
