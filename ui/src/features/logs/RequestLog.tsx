// The open request's log in the end panel (a bottom sheet on phones).
import { Download } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading } from "@astryxdesign/core/Text";
import { ReadError } from "../../components/ReadError.tsx";
import { saveBlob } from "../../lib/download.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { useRequestLog } from "./queries.ts";

function Body({ id }: { id: string }) {
  const log = useRequestLog(id);
  if (log.isError)
    return (
      <ReadError error={log.error} what={t("logs.request.what")} retry={() => void log.refetch()} />
    );
  if (log.data === undefined)
    return (
      <VStack gap={2} aria-busy aria-label={t("logs.request.loading")}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} width="100%" height={layout.valueSkeleton.height} index={i} />
        ))}
      </VStack>
    );
  const text = log.data;
  return (
    <VStack gap={3}>
      <HStack gap={2} hAlign="end">
        <Button
          label={t("logs.request.download")}
          size="sm"
          icon={<Icon icon={Download} size="sm" />}
          onClick={() => saveBlob(new Blob([text], { type: "text/plain" }), `request-${id}.log`)}
        />
      </HStack>
      <CodeBlock code={text} isWrapped width="100%" />
    </VStack>
  );
}

export function RequestLog({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <VStack gap={4}>
      <HStack gap={2} vAlign="start">
        <StackItem size="fill">
          <VStack gap={1}>
            <Heading level={2}>{t("logs.request.title")}</Heading>
            <Code>{id}</Code>
          </VStack>
        </StackItem>
        <IconButton
          label={t("logs.request.close")}
          variant="ghost"
          size="sm"
          icon={<Icon icon="close" size="sm" />}
          onClick={onClose}
        />
      </HStack>
      <Body id={id} />
    </VStack>
  );
}
