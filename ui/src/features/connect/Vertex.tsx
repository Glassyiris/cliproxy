import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileInput } from "@astryxdesign/core/FileInput";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { serverKeys } from "../../app/serverQueries.ts";
import type { Action } from "../../app/useAction.ts";
import { ApiError } from "../../lib/api/client.ts";
import { importVertex, type VertexImport } from "../../lib/api/oauth.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";

/**
 * The Vertex import: its region and file, the import itself, and what it returned. `onGone` marks
 * Vertex unavailable when the server answers that it has no Vertex import.
 */
export function useVertexImport(action: Action, onGone: () => void) {
  const queryClient = useQueryClient();
  const [region, setRegion] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [missing, setMissing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState<VertexImport | null>(null);
  const submit = () => {
    setMissing(!file);
    if (!file) return Promise.resolve(false);
    return action.run(async () => {
      setImporting(true);
      try {
        // The server uses us-central1 for an empty region.
        const r = await importVertex(file, region.trim()).catch((e: unknown) => {
          if (!(e instanceof ApiError && e.code === "provider_not_found")) throw e;
          onGone();
          throw new Error(t("connect.vertex.notOnServer"));
        });
        await queryClient.invalidateQueries({ queryKey: serverKeys.credentials });
        notify(
          "success",
          t("connect.vertex.imported", { project: r.project_id, location: r.location }),
        );
        setDone(r);
      } finally {
        setImporting(false);
      }
    });
  };
  return {
    region,
    setRegion,
    file,
    setFile: (files: File | File[] | null) => {
      setFile(Array.isArray(files) ? (files[0] ?? null) : files);
      setMissing(false);
    },
    missing,
    importing,
    done,
    submit,
    reset: () => {
      setFile(null);
      setDone(null);
    },
  };
}

type VertexImportState = ReturnType<typeof useVertexImport>;

/** Step 2 for Vertex: the region and the service-account file. */
export function VertexFields({ vertex }: { vertex: VertexImportState }) {
  return (
    <FormLayout defaultOptionality="optional">
      <TextInput
        label={t("connect.vertex.region")}
        value={vertex.region}
        onChange={vertex.setRegion}
        placeholder={t("connect.vertex.regionPlaceholder")}
        autoComplete="off"
      />
      <FileInput
        label={t("connect.vertex.file")}
        description={t("connect.vertex.fileHint")}
        isRequired
        value={vertex.file}
        onChange={vertex.setFile}
        accept=".json,application/json"
        isLoading={vertex.importing}
        status={
          vertex.missing ? { type: "error", message: t("connect.vertex.fileMissing") } : undefined
        }
      />
    </FormLayout>
  );
}

/** Step 3 for Vertex: the project and region the server stored the account under. */
export function VertexResult({ done }: { done: VertexImport }) {
  return (
    <FormLayout>
      <Text type="body">{t("connect.vertex.done")}</Text>
      <MetadataList>
        <MetadataListItem label={t("connect.vertex.account")}>{done.email}</MetadataListItem>
        <MetadataListItem label={t("connect.vertex.project")}>{done.project_id}</MetadataListItem>
        <MetadataListItem label={t("connect.vertex.location")}>{done.location}</MetadataListItem>
      </MetadataList>
    </FormLayout>
  );
}
