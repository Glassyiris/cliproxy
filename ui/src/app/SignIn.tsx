import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Server } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Heading, Text } from "@astryxdesign/core/Text";
import { KeyField } from "../components/KeyField.tsx";
import { StatusLamp } from "../components/StatusLamp.tsx";
import { healthz } from "../lib/api/system.ts";
import { t } from "../lib/i18n.ts";
import { repository } from "../lib/repository.ts";
import { layout } from "../themes/site/layout.ts";
import { roles } from "../themes/site/roles.ts";
import { PreferenceMenus } from "./PreferenceMenus.tsx";
import { useSession } from "./Session.tsx";
import { useDocumentTitle } from "./useDocumentTitle.ts";

/** Lamp, host and whether GET /healthz answers; checked again every 10 s while the tab is shown. */
function ServerReachability() {
  const health = useQuery({
    queryKey: ["sign-in", "healthz"],
    queryFn: ({ signal }) => healthz(signal),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const host = location.host;
  const [status, label] =
    health.data === undefined
      ? (["disabled", t("app.signIn.checking", { host })] as const)
      : health.data
        ? (["ready", t("app.signIn.reachable", { host })] as const)
        : (["failing", t("app.signIn.unreachable", { host })] as const);
  return (
    <VStack role="status" hAlign="center">
      <StatusLamp status={status} label={label} />
    </VStack>
  );
}

/** Brand mark and name above the card, as login-card:92-97. */
function Brand() {
  return (
    <VStack gap={2} hAlign="center">
      <Icon icon={Server} size="lg" />
      <Text type="body" weight="bold" size="lg">
        {t("app.brand.name")}
      </Text>
    </VStack>
  );
}

/** Card heading and the server's reachability, as login-card:102-107. */
function CardTop() {
  return (
    <VStack gap={1} hAlign="center">
      <Heading level={roles.heading.section}>{t("app.signIn.heading")}</Heading>
      <ServerReachability />
    </VStack>
  );
}

/** Where the management key comes from, folded under a supporting-size line. */
function KeyHelp() {
  return (
    <Collapsible
      trigger={
        <Text type="supporting" color="secondary">
          {t("app.signIn.helpTitle")}
        </Text>
      }
      defaultIsOpen={false}
    >
      <Text type="supporting" color="secondary">
        {t("app.signIn.help", { setting: "management.secret-key" })}
      </Text>
    </Collapsible>
  );
}

export function SignIn() {
  const { signIn } = useSession();
  const [secret, setSecret] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  // One request per press: the ref blocks a second submit before the busy state renders.
  const pending = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useDocumentTitle(t("app.document.signInTitle"));

  const submit = async () => {
    if (pending.current) return;
    if (!secret) {
      setFailure(t("app.signIn.keyRequired"));
      input.current?.focus();
      return;
    }
    pending.current = true;
    setBusy(true);
    setFailure("");
    try {
      await signIn(secret);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setBusy(false);
      pending.current = false;
      input.current?.focus();
    }
  };

  return (
    <VStack minHeight="100dvh" padding={4} gap={4}>
      <HStack hAlign="end">
        <PreferenceMenus />
      </HStack>
      {/* Two growing spacers centre the card in the space below the controls and let it scroll. */}
      <StackItem size="fill" />
      <VStack hAlign="center" gap={4}>
        <Brand />
        <Card padding={8} width="100%" maxWidth={layout.signInWidth}>
          {/* Enter is handled by the field's IME-safe onEnter; the form's own submit is dropped. */}
          <VStack as="form" gap={4} onSubmit={(event) => event.preventDefault()}>
            <CardTop />
            <VStack gap={4}>
              <KeyField
                label={t("app.signIn.managementKey")}
                kind="sign-in"
                secret={secret}
                onChange={(value) => {
                  setSecret(value);
                  if (failure) setFailure("");
                }}
                failure={failure}
                submit={() => void submit()}
                inputRef={input}
              />
              <Button
                label={busy ? t("app.signIn.connecting") : t("app.signIn.connect")}
                variant="primary"
                size="lg"
                isLoading={busy}
                width="100%"
                onClick={() => void submit()}
              />
            </VStack>
            <KeyHelp />
          </VStack>
        </Card>
        <Link href={repository.url} target="_blank" type="supporting" color="secondary">
          {t("app.signIn.repository", { repository: repository.name })}
        </Link>
      </VStack>
      <StackItem size="fill" />
    </VStack>
  );
}
