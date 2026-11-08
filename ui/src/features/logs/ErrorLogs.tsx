// The error logs: one row per file the server kept for a failed request, newest as listed.
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { icons } from "../../components/icons.ts";
import { useAction } from "../../app/useAction.ts";
import { Identifier } from "../../components/Identifier.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { downloadErrorLog, type ErrorLogFile } from "../../lib/api/logs.ts";
import { saveBlob } from "../../lib/download.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import type { useErrorLogs } from "./queries.ts";

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
      label={<Identifier breakAt="name">{file.name}</Identifier>}
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
          variant={roles.rowAction.variant}
          size={roles.rowAction.size}
          icon={<Icon icon={icons.download} size="sm" />}
          isLoading={isPending}
          onClick={onDownload}
        />
      }
    />
  );
}

/** The error log files: `files` is their read, `shown` those matching the search. */
export function ErrorLogs({
  files,
  shown,
  onShowAll,
}: {
  files: ReturnType<typeof useErrorLogs>;
  shown: ErrorLogFile[] | undefined;
  onShowAll: () => void;
}) {
  const { pending, download } = useDownload();
  if (files.isError)
    return (
      <ReadError
        error={files.error}
        what={t("logs.errors.what")}
        retry={() => void files.refetch()}
      />
    );
  if (!files.data || !shown)
    return (
      <VStack gap={3} aria-busy aria-label={t("logs.errors.loading")}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} width="100%" height={layout.valueSkeleton.height} index={i} />
        ))}
      </VStack>
    );
  if (!files.data.length)
    return (
      <EmptyState
        icon={<Icon icon={icons.logs} size="lg" />}
        title={t("logs.errors.empty")}
        headingLevel={roles.heading.section}
      />
    );
  if (!shown.length)
    return (
      <EmptyState
        icon={<Icon icon="search" size="lg" />}
        title={t("logs.errors.noMatch")}
        headingLevel={roles.heading.section}
        actions={<Button label={t("logs.errors.showAll")} onClick={onShowAll} />}
      />
    );
  return (
    <List hasDividers>
      {shown.map((f) => (
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
