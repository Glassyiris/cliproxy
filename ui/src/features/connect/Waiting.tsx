import { useState, type ReactNode, type Ref } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ReadError } from "../../components/ReadError.tsx";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { isWebAddress, owner } from "./flow.ts";
import type { Flow, SignIn } from "./useSignIn.ts";

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <VStack gap={2}>
      <Text type="body" weight="bold">
        {title}
      </Text>
      {children}
    </VStack>
  );
}

function CopyLink({ url }: { url: string }) {
  const { copy, isCopied } = useClipboard({ announce: t("connect.wait.linkCopied") });
  return (
    <Button
      label={t("connect.wait.copyLink")}
      variant="secondary"
      icon={<Icon icon={isCopied ? "check" : "copy"} />}
      onClick={() =>
        void copy(url).then((ok) =>
          ok
            ? notify("success", t("connect.wait.linkCopied"))
            : notify("error", t("connect.wait.copyFailed")),
        )
      }
    />
  );
}

/** The redirect page did not load: the operator pastes its address, which carries the code. */
function CallbackFallback({ signIn }: { signIn: SignIn }) {
  const [address, setAddress] = useState("");
  const [failure, setFailure] = useState("");
  const send = () => {
    if (signIn.busy) return;
    const value = address.trim();
    if (!isWebAddress(value)) return setFailure(t("connect.callback.invalid"));
    setFailure("");
    void signIn.sendCallback(value);
  };
  return (
    <Collapsible trigger={t("connect.callback.trigger")} defaultIsOpen={false}>
      <VStack gap={2}>
        {/* The address carries the OAuth code and state, so it stays masked. */}
        <TextInput
          label={t("connect.callback.label")}
          type="password"
          value={address}
          onChange={setAddress}
          onEnter={send}
          autoComplete="off"
          status={failure ? { type: "error", message: failure } : undefined}
        />
        <HStack>
          <Button
            label={t("connect.callback.send")}
            variant="secondary"
            isLoading={signIn.pending === "callback"}
            onClick={send}
          />
        </HStack>
      </VStack>
    </Collapsible>
  );
}

/** Waiting for approval: the steps on the provider's page, the fallback and Cancel. */
export function Waiting({
  flow,
  signIn,
  lead,
}: {
  flow: Flow;
  signIn: SignIn;
  lead: Ref<HTMLButtonElement>;
}) {
  const who = owner(flow.provider);
  const open = (
    <HStack gap={2} wrap="wrap">
      <Button
        ref={lead}
        label={t("connect.wait.open")}
        variant="primary"
        icon={<Icon icon="externalLink" />}
        href={flow.url}
        target="_blank"
        rel="noopener noreferrer"
      />
      <CopyLink url={flow.url} />
    </HStack>
  );
  return (
    <VStack gap={4}>
      <Step title={t("connect.wait.openStep", { owner: who })}>
        {open}
        {flow.userCode && (
          <Text type="supporting" color="secondary">
            {t("connect.wait.anyDevice")}
          </Text>
        )}
      </Step>
      {flow.userCode ? (
        <Step title={t("connect.wait.codeStep")}>
          <CodeBlock
            code={flow.userCode}
            language="plaintext"
            onCopy={() => notify("success", t("connect.wait.codeCopied"))}
            onCopyError={() => notify("error", t("connect.wait.copyFailed"))}
          />
          <Text type="supporting" color="secondary">
            {t("connect.wait.polling")}
          </Text>
        </Step>
      ) : (
        <Step title={t("connect.wait.approveStep")}>
          <Text type="body" color="secondary">
            {t("connect.wait.updates")}
          </Text>
        </Step>
      )}
      {!flow.device && <CallbackFallback signIn={signIn} />}
      {signIn.statusError !== null && (
        <ReadError
          error={signIn.statusError}
          what={t("connect.wait.status")}
          retry={signIn.retryStatus}
        />
      )}
      <HStack>
        <Button
          label={t("connect.wait.cancel")}
          variant="ghost"
          isLoading={signIn.pending === "cancel"}
          onClick={() => void signIn.cancel()}
        />
      </HStack>
    </VStack>
  );
}
