// The Error logs tab: one row per file the server kept for a failed request, newest as listed.
import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";

import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useAction } from "../../app/useAction.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { downloadErrorLog, type ErrorLogFile } from "../../lib/api/logs.ts";
import { saveBlob } from "../../lib/download.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { useErrorLogs } from "./queries.ts";

/** Downloads are reads: they wait for one another, not for the page's writes. */
function useDownload() {
  const { busy, run } = useAction();
  const [pending, setPending] = useState("");
  const download = async (name: string) => {
    if (busy) return;
    setPending(name);
    await run(async () => saveBlob(await downloadErrorLog(name), name));
    setPending("");
  };
  return { pending, download };
}

function FileRow({
  file,
  isPending,
  onDownload,
}: {
  file: ErrorLogFile;
  isPending: boolean;
  onDownload: () => void;
}) {
  return (
    <ListItem
      label={<Code>{file.name}</Code>}
      description={
        <HStack gap={2} vAlign="center" wrap="wrap">
          {file.modified > 0 && (
            <Timestamp value={file.modified} format="date_time" color="secondary" />
          )}
          <Text type="supporting" color="secondary" hasTabularNumbers>
            {t("logs.errors.size", { size: file.size / 1024 })}
          </Text>
        </HStack>
      }
      endContent={
        <Button
          label={t("logs.errors.download")}
          size="sm"
          icon={<Icon icon={Download} size="sm" />}
          isLoading={isPending}
          onClick={onDownload}
        />
      }
    />
  );
}

export function ErrorLogs() {
  const files = useErrorLogs();
  const { pending, download } = useDownload();
  if (files.isError)
    return (
      <ReadError
        error={files.error}
        what={t("logs.errors.what")}
        retry={() => void files.refetch()}
      />
    );
  if (!files.data)
    return (
      <VStack gap={3} aria-busy aria-label={t("logs.errors.loading")}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} width="100%" height={layout.valueSkeleton.height} index={i} />
        ))}
      </VStack>
    );
  if (!files.data.length) return <EmptyState title={t("logs.errors.empty")} headingLevel={2} />;
  return (
    <List hasDividers>
      {files.data.map((f) => (
        <FileRow
          key={f.name}
          file={f}
          isPending={pending === f.name}
          onDownload={() => void download(f.name)}
        />
      ))}
    </List>
  );
}
