import { useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useConfig, useConfigWrite } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { useHashParams } from "../../app/useHashRoute.ts";
import { base } from "../../lib/api/client.ts";
import type { Config } from "../../lib/api/config.ts";
import { newKey } from "../../lib/client-keys.ts";
import { t } from "../../lib/i18n.ts";
import { isLocalHost, toolTarget } from "./address.ts";
import { AddressKey } from "./AddressKey.tsx";
import { SetUpTool, toolSectionId } from "./SetUpTool.tsx";
import { toolFromParam, toolParam } from "./tool.ts";
import { useKeyChoice } from "./useKeyChoice.ts";

const KEYS_PATH = "access/api-keys";
const local = isLocalHost(location.hostname);

/**
 * What the server holds, for the compare in `replaceConfigValue`: `null` stays `null`, and a key
 * the file lacks reads as the empty list, which is what the server's 404 fallback reads as.
 */
function storedKeys(config: Config): string[] | null {
  const access = config.access as Record<string, unknown> | null | undefined;
  return (access && "api-keys" in access ? access["api-keys"] : []) as string[] | null;
}

function NoKey({ busy, create }: { busy: boolean; create: () => void }) {
  return (
    <EmptyState
      title={t("use.empty.title")}
      description={t("use.empty.description")}
      headingLevel={2}
      actions={
        <Button
          label={t("use.empty.create")}
          variant="primary"
          icon={<Icon icon={Plus} />}
          isLoading={busy}
          onClick={create}
        />
      }
    />
  );
}

export default function UseWithTools() {
  const config = useConfig();
  const action = useAction();
  const write = useConfigWrite(action);
  const [params, setParams] = useHashParams();
  const tool = toolFromParam(params.tool);
  const createdFrom = useRef<{ control: Element | null } | null>(null);

  const stored = config.data ? storedKeys(config.data) : undefined;
  const keys = stored === undefined ? undefined : (stored ?? []);
  const { key, model, choice } = useKeyChoice(keys);

  useEffect(() => {
    if (!createdFrom.current || !key) return;
    const { control } = createdFrom.current;
    createdFrom.current = null;
    // The Create control is gone now; continue at the tool choice unless the user moved on.
    const now = document.activeElement;
    if (now && now !== document.body && now !== control) return;
    document
      .querySelector<HTMLElement>(
        `#${toolSectionId} [role="radio"][aria-checked="true"], #${toolSectionId} [role="combobox"]`,
      )
      ?.focus();
  });

  const create = async () => {
    if (!keys) return;
    createdFrom.current = { control: document.activeElement };
    if (!(await write(KEYS_PATH, stored, [...keys, newKey()], t("use.empty.created"))))
      createdFrom.current = null;
  };

  return (
    <PageFrame
      title={t("use.page.title")}
      meta={
        <Text type="supporting" color="secondary">
          {t("use.page.description")}
        </Text>
      }
    >
      <AddressKey
        base={base}
        local={local}
        choice={choice}
        loading={config.isPending}
        error={
          config.isError ? { error: config.error, retry: () => void config.refetch() } : undefined
        }
      />
      {keys && <Divider />}
      {key && (
        <SetUpTool
          tool={tool}
          onTool={(next) => setParams({ tool: toolParam(next) })}
          target={toolTarget(tool, base, local)}
          clientKey={key}
          model={model}
        />
      )}
      {keys?.length === 0 && <NoKey busy={action.busy} create={() => void create()} />}
    </PageFrame>
  );
}
