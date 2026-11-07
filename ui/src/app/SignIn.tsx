import { useState, type FormEvent } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { BrandIcon } from "../components/icons.tsx";
import { t } from "../lib/i18n.ts";
import { layout } from "../themes/site/layout.ts";
import { PreferenceMenus } from "./PreferenceMenus.tsx";
import { useSession } from "./Session.tsx";
import { useDocumentTitle } from "./useDocumentTitle.ts";

export function SignIn() {
  const { signIn } = useSession();
  const [secret, setSecret] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  useDocumentTitle(t("app.document.signInTitle"));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure("");
    try {
      await signIn(secret);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <Center axis="both" padding={4} minHeight="100dvh">
      <VStack gap={4} width="100%" maxWidth={layout.signInWidth}>
        <HStack vAlign="center" gap={2}>
          <Icon icon={BrandIcon} size="lg" />
          <StackItem size="fill">
            <Heading level={1}>{t("app.brand.name")}</Heading>
          </StackItem>
          <PreferenceMenus />
        </HStack>
        <Card padding={6} width="100%">
          <VStack as="form" gap={4} onSubmit={(event) => void submit(event)}>
            <TextInput
              label={t("app.signIn.managementKey")}
              type="password"
              value={secret}
              onChange={setSecret}
              hasAutoFocus
              autoComplete="current-password"
              width="100%"
            />
            {failure ? <Banner status="error" title={failure} role="alert" /> : null}
            <Button
              type="submit"
              variant="primary"
              label={busy ? t("app.signIn.connecting") : t("app.signIn.connect")}
              isLoading={busy}
              isDisabled={!secret}
              width="100%"
            />
          </VStack>
        </Card>
        <Text type="supporting">{t("app.signIn.help", { setting: "management.secret-key" })}</Text>
      </VStack>
    </Center>
  );
}
