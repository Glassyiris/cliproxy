// Template: settings-sidebar, its InfoRowItem rows (`settings-sidebar:122-139`): the name and one
// secondary line at the start, the action at the end, a divider under each row. Deviations:
// - Rows sit on SettingRow's two-column Grid, so the value and Edit line up with the controls above.
// - Edit is a Button: it opens an editor, an action (DESIGN.md "Links"); the template's is a Link.
// - The editor is the shared fullscreen ConfigEditor, not the template's expand-in-place row: a
//   section is JSON of any size, and the editor shows the diff before it writes.
// - The open editor is `?key=` in the hash, so links from other pages land on it and Back closes it.
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import type { Action } from "../../app/useAction.ts";
import { useHashParams } from "../../app/useHashRoute.ts";
import { ConfigEditor } from "../../components/ConfigEditor.tsx";
import type { Config } from "../../lib/api/config.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { Row } from "./SettingRow.tsx";
import { YAML_KEY } from "./settings.ts";

/** Top-level sections that a control edits somewhere in the dashboard, so not listed here. */
const covered = new Set([
  "config-version",
  "server",
  "management",
  "access",
  "routing",
  "requests",
  "observability",
  "oauth",
  "api-keys",
  "plugins",
  // Read once at start, and a v8 write comments it out (docs/CONFIGURATION.md "worker-threads").
  "worker-threads",
]);

/** Sections no control edits, listed even when the file lacks them, with what each is for. */
const purposes: Record<string, () => string> = {
  client: () => t("config.sections.client"),
  multimedia: () => t("config.sections.multimedia"),
  upstream: () => t("config.sections.upstream"),
  models: () => t("config.sections.models"),
  "model-routers": () => t("config.sections.modelRouters"),
};

/** The known sections first, then any other the file holds, in the file's order. */
const sectionsOf = (config: Config | undefined) => [
  ...new Set([
    ...Object.keys(purposes),
    ...Object.keys(config ?? {}).filter((key) => !covered.has(key)),
  ]),
];

/** What the file holds there: how many entries, or that the server uses its defaults. */
function amount(value: unknown) {
  if (value === undefined || value === null) return t("config.sections.default");
  if (typeof value !== "object") return typeof value === "string" ? value : JSON.stringify(value);
  const size = Array.isArray(value) ? value.length : Object.keys(value).length;
  return size ? t("config.sections.set", { count: size }) : t("config.sections.default");
}

function Entry({
  name,
  purpose,
  value,
  onEdit,
}: {
  name: string;
  purpose?: string;
  /** The amount; undefined while the file loads, null for the whole file. */
  value: string | null | undefined;
  onEdit: () => void;
}) {
  return (
    <VStack gap={0}>
      <Row label={name} hint={purpose}>
        <HStack gap={3} vAlign="center">
          <StackItem size="fill">
            {value === undefined ? (
              <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
            ) : (
              value && (
                <Text type={roles.textType.body} hasTabularNumbers>
                  {value}
                </Text>
              )
            )}
          </StackItem>
          <Button label={t("config.sections.edit")} variant="secondary" onClick={onEdit} />
        </HStack>
      </Row>
      <Divider />
    </VStack>
  );
}

/** The whole file, then every section without a control; Edit opens it in the editor. */
export function Advanced({ action, config }: { action: Action; config: Config | undefined }) {
  const [params, setParams] = useHashParams();
  const open = (key: string | undefined) => setParams({ key }, "push");
  const key = params.key;
  return (
    <VStack gap={0}>
      <Entry
        name={YAML_KEY}
        purpose={t("config.sections.file")}
        value={null}
        onEdit={() => open(YAML_KEY)}
      />
      {sectionsOf(config).map((name) => (
        <Entry
          key={name}
          name={name}
          purpose={purposes[name]?.()}
          value={config && amount(config[name])}
          onEdit={() => open(name)}
        />
      ))}
      <ConfigEditor
        source={!key ? null : key === YAML_KEY ? { yaml: true } : { path: key }}
        title={key === YAML_KEY ? t("config.yaml.label") : (key ?? "")}
        action={action}
        onClose={() => open(undefined)}
      />
    </VStack>
  );
}
