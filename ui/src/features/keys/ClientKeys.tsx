import { useState, type ReactNode } from "react";
import { Eye, Plus } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useConfig, useConfigWrite } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import type { Config } from "../../lib/api/config.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { t } from "../../lib/i18n.ts";
import { AddKeyDialog } from "./AddKeyDialog.tsx";
import { KeyTable } from "./KeyTable.tsx";
import { RemoveKeyDialog } from "./RemoveKeyDialog.tsx";

function NoKeys({ add }: { add: ReactNode }) {
  return (
    <>
      <Banner
        status="warning"
        title={t("keys.empty.bannerTitle")}
        description={t("keys.empty.bannerDescription")}
      />
      <EmptyState
        title={t("keys.empty.title")}
        description={t("keys.empty.description")}
        headingLevel={2}
        actions={add}
      />
    </>
  );
}

/** The reveal switch and the table; `keys` is undefined while the config loads. */
function KeyList({
  keys,
  onRemove,
}: {
  keys: string[] | undefined;
  onRemove: (key: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <VStack gap={3}>
      {keys && (
        <HStack>
          <ToggleButton
            label={t("keys.page.show")}
            icon={<Icon icon={Eye} />}
            pressedIcon={<Icon icon="eyeSlash" />}
            isPressed={revealed}
            onPressedChange={setRevealed}
          />
        </HStack>
      )}
      <KeyTable keys={keys} revealed={revealed} onRemove={onRemove} />
    </VStack>
  );
}

/**
 * What the server holds, for the compare in `replaceConfigValue`: `null` stays `null`, and a key
 * the file lacks reads as the empty list, which is what the server's 404 fallback reads as.
 */
function storedKeys(config: Config): string[] | null {
  const access = config.access as Record<string, unknown> | null | undefined;
  return (access && "api-keys" in access ? access["api-keys"] : []) as string[] | null;
}

const KEYS_PATH = "access/api-keys";
const apiKeyHeader = "x-api-key";

export default function ClientKeys() {
  const config = useConfig();
  const action = useAction();
  const write = useConfigWrite(action);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const stored = config.data ? storedKeys(config.data) : undefined;
  const keys = stored === undefined ? undefined : (stored ?? []);
  const addButton = (
    <Button
      label={t("keys.page.add")}
      variant="primary"
      icon={<Icon icon={Plus} />}
      onClick={() => setAdding(true)}
    />
  );

  const remove = async () => {
    if (keys && removing !== null)
      await write(
        KEYS_PATH,
        stored,
        keys.filter((k) => k !== removing),
        t("keys.remove.removed"),
      );
    setRemoving(null);
  };

  return (
    <PageFrame
      title={t("keys.page.title")}
      meta={
        keys && (
          <HStack>
            <Badge variant="neutral" label={keys.length} />
          </HStack>
        )
      }
      actions={keys?.length ? addButton : undefined}
    >
      <Text type="supporting" color="secondary">
        {t("keys.page.introBefore")}
        <Code>{apiKeyHeader}</Code>
        {t("keys.page.introAfter")}
      </Text>
      {config.isError && (
        <ReadError
          error={config.error}
          what={t("keys.page.what")}
          retry={() => void config.refetch()}
        />
      )}
      {keys?.length === 0 && <NoKeys add={addButton} />}
      {(config.isPending || !!keys?.length) && <KeyList keys={keys} onRemove={setRemoving} />}
      {adding && keys && (
        <AddKeyDialog
          keys={keys}
          busy={action.busy}
          add={(key) => write(KEYS_PATH, stored, [...keys, key], t("keys.add.added"))}
          onClose={() => setAdding(false)}
        />
      )}
      <RemoveKeyDialog
        target={removing}
        busy={action.busy}
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </PageFrame>
  );
}
