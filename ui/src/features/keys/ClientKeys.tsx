import { useState, type ReactNode } from "react";
import { Eye, Plus } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useConfig, useConfigWrite } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { Identifier } from "../../components/Identifier.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { readPath } from "../../lib/config-path.ts";
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

const KEYS_PATH = "access/api-keys";
const apiKeyHeader = "x-api-key";

export default function ClientKeys() {
  const config = useConfig();
  const action = useAction();
  const write = useConfigWrite(action);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // A key the file lacks and an explicit null both show as no keys.
  const keys = config.data ? (readPath(config.data, KEYS_PATH, []) as string[]) : undefined;
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
        <Identifier>{apiKeyHeader}</Identifier>
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
          add={(key) => write(KEYS_PATH, [...keys, key], t("keys.add.added"))}
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
