import { useRef, useState, type FormEvent, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
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
import { preloadSignedIn } from "./chunks.ts";
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
      <Icon icon={Network} size="lg" />
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

/**
 * Raw input, a documented exception (REQUIREMENTS.md): the username a password manager files the
 * key under, as Chromium's guidance for single-field sign-in forms asks. Astryx's VisuallyHidden
 * is a span and must not wrap a control.
 */
function SavedUsername() {
  return (
    <input
      type="text"
      name="username"
      autoComplete="username"
      value={location.host}
      readOnly
      hidden
    />
  );
}

/** Sign in with the typed key, one request per press, and say what went wrong. */
function useSubmit(input: RefObject<HTMLInputElement | null>) {
  const { signIn } = useSession();
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  // One request per press: the ref blocks a second submit before the busy state renders.
  const pending = useRef(false);

  const submit = async (secret: string, persist: boolean) => {
    if (pending.current) return;
    if (!secret) {
      setFailure(t("app.signIn.keyRequired"));
      input.current?.focus();
      return;
    }
    pending.current = true;
    // The shell loads while the key is checked.
    preloadSignedIn();
    setBusy(true);
    setFailure("");
    try {
      await signIn(secret, persist);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setBusy(false);
      pending.current = false;
      input.current?.focus();
    }
  };
  return { failure, setFailure, busy, submit };
}

export function SignIn() {
  const [secret, setSecret] = useState("");
  // Off on every load: keeping the key on the device is chosen each time.
  const [persist, setPersist] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { failure, setFailure, busy, submit } = useSubmit(input);
  useDocumentTitle(t("app.document.signInTitle"));

  // A real submit, so the browser's password manager offers to save the key; the form unmounts on
  // success, which Chrome and Firefox take as a finished sign-in.
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(secret, persist);
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
          {/* Enter and Connect both submit the form; the key field holds Enter during IME input. */}
          <VStack as="form" gap={4} onSubmit={onSubmit}>
            <CardTop />
            <SavedUsername />
            <VStack gap={4}>
              <KeyField
                label={t("app.signIn.managementKey")}
                kind="sign-in"
                secret={secret}
                onChange={(value) => {
                  // Typing a key is the sign that the shell will be needed.
                  preloadSignedIn();
                  setSecret(value);
                  if (failure) setFailure("");
                }}
                failure={failure}
                htmlName="password"
                inputRef={input}
              />
              <CheckboxInput
                label={t("app.signIn.remember")}
                value={persist}
                onChange={setPersist}
              />
              <Button
                label={busy ? t("app.signIn.connecting") : t("app.signIn.connect")}
                variant="primary"
                size="lg"
                isLoading={busy}
                width="100%"
                type="submit"
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
