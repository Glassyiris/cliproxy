import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { serverKeys } from "../../app/serverQueries.ts";
import type { Action } from "../../app/useAction.ts";
import { useAvailable } from "../../components/MissingActions.tsx";
import { ApiError } from "../../lib/api/client.ts";
import { importVertex } from "../../lib/api/oauth.ts";
import { routes } from "../../lib/api/routes.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";

/** Vertex service-account import, and the way to provider keys. */
export function OtherWays({ action }: { action: Action }) {
  const queryClient = useQueryClient();
  const [region, setRegion] = useState("");
  const [pressed, setPressed] = useState(false);
  const [gone, setGone] = useState(false);
  const enabled = useAvailable()(routes.importOAuth) && !gone;
  const upload = (files: File | File[] | null) => {
    const file = Array.isArray(files) ? files[0] : files;
    if (!file) return;
    void action.run(async () => {
      setPressed(true);
      try {
        // The server uses us-central1 for an empty region.
        const r = await importVertex(file, region.trim()).catch((e: unknown) => {
          if (!(e instanceof ApiError && e.code === "provider_not_found")) throw e;
          setGone(true);
          throw new Error(t("connect.vertex.notOnServer"));
        });
        await queryClient.invalidateQueries({ queryKey: serverKeys.credentials });
        notify(
          "success",
          t("connect.vertex.imported", { project: r.project_id, location: r.location }),
        );
      } finally {
        setPressed(false);
      }
    });
  };
  return (
    <VStack gap={4}>
      <Heading level={2}>{t("connect.other.heading")}</Heading>
      <List density="compact" hasDividers>
        <ListItem
          label={<Text type="body">{t("connect.vertex.label")}</Text>}
          description={
            <HStack gap={2} vAlign="end" wrap="wrap">
              <TextInput
                label={t("connect.vertex.region")}
                value={region}
                onChange={setRegion}
                placeholder={t("connect.vertex.regionPlaceholder")}
                autoComplete="off"
                isDisabled={!enabled}
              />
              <FileInput
                label={t("connect.vertex.file")}
                placeholder={t("connect.vertex.import")}
                value={null}
                onChange={upload}
                accept=".json,application/json"
                isDisabled={!enabled}
                disabledMessage={t("connect.vertex.unavailable")}
                isLoading={action.busy && pressed}
              />
            </HStack>
          }
        />
        <ListItem
          label={t("connect.apiKey.label")}
          description={t("connect.apiKey.description")}
          href="#providers"
          endContent={<Icon icon="chevronRight" size="sm" color="secondary" />}
        />
      </List>
    </VStack>
  );
}
