import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading } from "@astryxdesign/core/Text";
import type { KeyTest } from "../../app/useKeyTest.ts";
import { Identifier } from "../../components/Identifier.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { mask } from "../../lib/client-keys.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { layout } from "../../themes/site/layout.ts";
import type { KeyChoice } from "./useKeyChoice.ts";

function CopyableAddress({ value }: { value: string }) {
  const { copy, isCopied } = useClipboard({ announce: t("use.address.copied") });
  return (
    <HStack gap={1} vAlign="center">
      <Identifier>{value}</Identifier>
      <IconButton
        label={t("use.address.copy")}
        tooltip={t("use.address.copy")}
        variant="ghost"
        size="sm"
        icon={<Icon icon={isCopied ? "check" : "copy"} size="sm" />}
        onClick={() =>
          void copy(value).then((ok) => ok || notify("error", t("use.address.copyFailed")))
        }
      />
    </HStack>
  );
}

function TestLine({ result }: { result: KeyTest }) {
  switch (result.status) {
    case "idle":
      return null;
    case "testing":
      return <StatusLamp status="disabled" label={t("use.test.testing")} />;
    case "ready":
      return (
        <StatusLamp status="ready" label={t("use.test.ready", { count: result.models.length })} />
      );
    case "noModels":
      return <StatusLamp status="cooling" label={t("use.test.noModels")} />;
    case "failed":
      return <StatusLamp status="failing" label={result.message} />;
  }
}

/** Region 1. `choice` is undefined while the config loads, or when no key can be offered. */
export function AddressKey({
  base,
  local,
  choice,
  loading,
  error,
}: {
  base: string;
  local: boolean;
  choice: KeyChoice | undefined;
  loading: boolean;
  error: { error: unknown; retry: () => void } | undefined;
}) {
  return (
    <VStack gap={4}>
      <Heading level={2}>{t("use.address.heading")}</Heading>
      <MetadataList aria-busy={loading}>
        <MetadataListItem label={t("use.address.proxy")}>
          <CopyableAddress value={base} />
        </MetadataListItem>
        <MetadataListItem label={t("use.address.openai")}>
          <CopyableAddress value={`${base}/v1`} />
        </MetadataListItem>
        {loading && (
          <MetadataListItem label={t("use.address.key")}>
            <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
          </MetadataListItem>
        )}
        {choice && choice.keys.length > 1 && (
          <MetadataListItem label={t("use.address.key")}>
            <Selector
              label={t("use.address.key")}
              isLabelHidden
              options={choice.keys.map((key, i) => ({ value: String(i), label: mask(key) }))}
              value={String(choice.index)}
              onChange={(value) => choice.onIndex(Number(value))}
            />
          </MetadataListItem>
        )}
        {choice && choice.models.length > 0 && (
          <MetadataListItem label={t("use.address.model")}>
            <Selector
              label={t("use.address.model")}
              isLabelHidden
              options={choice.models}
              value={choice.model}
              onChange={choice.onModel}
            />
          </MetadataListItem>
        )}
      </MetadataList>
      {local && (
        <Banner
          status="warning"
          title={t("use.address.localTitle")}
          description={t("use.address.localDescription")}
        />
      )}
      {error && <ReadError error={error.error} what={t("use.page.what")} retry={error.retry} />}
      {choice && (
        <HStack gap={3} vAlign="center" wrap="wrap">
          <VStack role="status">
            <TestLine result={choice.result} />
          </VStack>
          <Button
            label={t("use.test.again")}
            variant="secondary"
            size="sm"
            isLoading={choice.result.status === "testing"}
            onClick={choice.onTest}
          />
        </HStack>
      )}
    </VStack>
  );
}
