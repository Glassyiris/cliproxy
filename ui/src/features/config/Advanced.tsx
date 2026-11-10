// Template: settings-sidebar, its InfoRowItem rows (`settings-sidebar:122-139`): the name and one
// secondary line at the start, the action at the end, a divider under each row. Deviations:
// - Rows are SettingRow's, so the value and Edit end the row as the controls above do.
// - Edit is a Button: it opens an editor, an action (DESIGN.md "Links"); the template's is a Link.
// - The editor is the shared ConfigEditor dialog, not the template's expand-in-place row: a
//   section is JSON of any size, and the editor shows the diff before it writes.
// - The open editor is `?key=` in the hash, so links from other pages land on it and Back closes it.
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import type { Action } from "../../app/useAction.ts";
import { useHashParams } from "../../app/useHashRoute.ts";
import { ConfigEditor } from "../../components/ConfigEditor.tsx";
import { PluginConfigEditor } from "../../components/PluginConfigEditor.tsx";
import type { Config } from "../../lib/api/config.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { Row } from "./SettingRow.tsx";

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
  // Read once at startup; changes require a restart.
  "worker-threads",
]);

/** Sections no control edits, listed even when absent, with what each is for. */
const purposes: Record<string, () => string> = {
  client: () => t("config.sections.client"),
  multimedia: () => t("config.sections.multimedia"),
  upstream: () => t("config.sections.upstream"),
  models: () => t("config.sections.models"),
  "model-routers": () => t("config.sections.modelRouters"),
};

/** The known sections first, then other stored sections, in their returned order. */
const sectionsOf = (config: Config | undefined) => [
  ...new Set([
    ...Object.keys(purposes),
    ...Object.keys(config ?? {}).filter((key) => !covered.has(key)),
  ]),
];

/** The stored amount: how many entries, or that the server uses its defaults. */
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
  /** The amount; undefined while the config loads. */
  value: string | undefined;
  onEdit: () => void;
}) {
  return (
    <VStack gap={0}>
      <Row label={name} hint={purpose}>
        <HStack gap={3} vAlign="center">
          {value === undefined ? (
            <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
          ) : (
            value && (
              <Text type={roles.textType.body} color="secondary" hasTabularNumbers>
                {value}
              </Text>
            )
          )}
          <Button label={t("config.sections.edit")} variant="secondary" onClick={onEdit} />
        </HStack>
      </Row>
      <Divider />
    </VStack>
  );
}

/** Every section without a control; Edit opens it as JSON in the editor. */
export function Advanced({ action, config }: { action: Action; config: Config | undefined }) {
  const [params, setParams] = useHashParams();
  const open = (key: string | undefined) => setParams({ key }, "push");
  const key = params.key;
  const pluginId = key ? /^plugins\/configs\/([^/]+)$/.exec(key)?.[1] : undefined;
  return (
    <VStack gap={0}>
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
        source={key && !pluginId ? { path: key } : null}
        title={key ?? ""}
        hashKey="key"
        action={action}
        onClose={() => open(undefined)}
      />
      <PluginConfigEditor
        id={pluginId ?? null}
        title={key ?? ""}
        hashKey="key"
        action={action}
        onClose={() => open(undefined)}
      />
    </VStack>
  );
}
