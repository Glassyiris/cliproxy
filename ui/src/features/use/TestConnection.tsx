import { useEffect } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { useKeyTest, type KeyTest } from "../../app/useKeyTest.ts";
import { Identifier } from "../../components/Identifier.tsx";
import { mask } from "../../lib/client-keys.ts";
import { flag } from "../../lib/first-run.ts";
import { t } from "../../lib/i18n.ts";
import { roles } from "../../themes/site/roles.ts";

const modelsAddress = (base: string) => `${base}/v1/models`;

/** One banner for every state, so the result replaces the wait in the same place. */
function Result({ result }: { result: KeyTest }) {
  switch (result.status) {
    case "idle":
    case "testing":
      return <Banner status="info" title={t("use.test.testing")} />;
    case "ready":
      return (
        <Banner
          status="success"
          title={t("use.test.ready")}
          description={t("use.test.readyDescription", { count: result.models.length })}
        />
      );
    case "noModels":
      return (
        <Banner
          status="warning"
          title={t("use.test.noModels")}
          description={t("use.test.noModelsDescription")}
        />
      );
    case "failed":
      return <Banner status="error" title={t("use.test.failed")} description={result.message} />;
  }
}

/** Step 3: ask the proxy for its models with the key, as the tool will, on entry and on request. */
export function TestConnection({ base, clientKey }: { base: string; clientKey: string }) {
  const { result, test } = useKeyTest();
  useEffect(() => {
    void test(clientKey);
  }, [clientKey, test]);
  // Overview's first run counts its test step done once a test here has served models.
  useEffect(() => {
    if (result.status === "ready") flag.set("start-test", "1");
  }, [result.status]);
  return (
    <VStack gap={roles.gap.card}>
      <MetadataList columns="single">
        <MetadataListItem label={t("use.test.address")}>
          <Identifier>{modelsAddress(base)}</Identifier>
        </MetadataListItem>
        <MetadataListItem label={t("use.test.key")}>
          <Identifier>{mask(clientKey)}</Identifier>
        </MetadataListItem>
      </MetadataList>
      {/* A new banner per state: inserting the live region is what announces the result. */}
      <Result key={result.status} result={result} />
      <HStack>
        <Button
          label={t("use.test.again")}
          variant="secondary"
          isLoading={result.status === "testing"}
          onClick={() => void test(clientKey)}
        />
      </HStack>
    </VStack>
  );
}
