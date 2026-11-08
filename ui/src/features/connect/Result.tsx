import type { Ref } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useQuota } from "../../app/QuotaProvider.tsx";
import { QuotaWindow, quotaErrorText } from "../../components/QuotaWindow.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { stateWord } from "../../components/StatusLamp.tsx";
import { accountRow, credName, label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { owner } from "./flow.ts";
import type { Flow, SignIn } from "./useSignIn.ts";

type Props = { flow: Flow; signIn: SignIn; lead: Ref<HTMLButtonElement> };

const openAccounts = (
  variant: "primary" | "secondary" | "ghost",
  lead?: Ref<HTMLButtonElement>,
) => (
  <Button ref={lead} label={t("connect.result.openAccounts")} variant={variant} href="#accounts" />
);

export function Verifying({ flow }: { flow: Flow }) {
  const done = <Icon icon="check" size="sm" color="success" />;
  return (
    <List density="compact">
      <ListItem
        startContent={done}
        label={t("connect.verify.approved", { owner: owner(flow.provider) })}
      />
      <ListItem startContent={done} label={t("connect.verify.saved")} />
      <ListItem startContent={<Spinner size="sm" />} label={t("connect.verify.reading")} />
    </List>
  );
}

/** The new account with the bars of this sign-in's own usage read, never older numbers. */
function Account({ flow }: { flow: Flow }) {
  const account = flow.account!;
  const row = accountRow(account, flow.read, true, true, flow.at);
  const live = flow.phase === "ok" && !!flow.read && "windows" in flow.read && !flow.read.error;
  const plan = [label(flow.provider), account.id_token?.plan_type].filter(Boolean).join(" ");
  const word =
    flow.phase === "refused" ? t("connect.result.tokenSaved") : stateWord(row.state, flow.at);
  return (
    <VStack gap={2}>
      <List density="compact">
        <ListItem
          label={credName(account)}
          description={t("connect.result.line", { plan, word })}
        />
      </List>
      {live && (
        <>
          <QuotaWindow bar={row.session} now={flow.at} />
          <QuotaWindow bar={row.weekly} now={flow.at} />
          <Text type="supporting" color="secondary">
            {t("connect.result.checked")}
          </Text>
        </>
      )}
    </VStack>
  );
}

function Refused({ flow, signIn, lead }: Props) {
  return (
    <>
      <Banner
        status="error"
        title={t("connect.result.refusedTitle", { provider: label(flow.provider) })}
        description={flow.read?.error && quotaErrorText(flow.read.error)}
      />
      <Text type="supporting" color="secondary">
        {t("connect.result.refusedNote")}
      </Text>
      <HStack gap={2} wrap="wrap">
        <Button
          label={t("connect.result.tryAgain")}
          variant="secondary"
          icon={<Icon icon={RefreshCw} />}
          isLoading={signIn.pending === "tryAgain"}
          onClick={() => void signIn.tryAgain()}
        />
        <Button
          ref={lead}
          label={t("connect.result.signInAgain")}
          variant="primary"
          isLoading={signIn.pending === flow.provider}
          onClick={() => void signIn.start(flow.provider)}
        />
        {openAccounts("ghost")}
      </HStack>
    </>
  );
}

function Connected({ flow, signIn, lead }: Props) {
  const quota = useQuota();
  const { account, read } = flow;
  return (
    <>
      {flow.reread !== null ? (
        <ReadError
          error={flow.reread}
          what={t("connect.result.accounts")}
          retry={() => void signIn.reread()}
        />
      ) : read?.error ? (
        <Banner
          status="error"
          title={t("connect.result.readFailed")}
          description={quotaErrorText(read.error)}
        />
      ) : (
        !read &&
        account &&
        quota.canCheck(account) && (
          <Text type="supporting" color="secondary">
            {t("connect.result.notRead")}
          </Text>
        )
      )}
      <HStack gap={2} wrap="wrap">
        <Button
          ref={lead}
          label={t("connect.result.another", { provider: label(flow.provider) })}
          variant="primary"
          icon={<Icon icon={Plus} />}
          isLoading={signIn.pending === flow.provider}
          onClick={() => void signIn.start(flow.provider)}
        />
        {openAccounts("secondary")}
      </HStack>
    </>
  );
}

/** Connected or refused: the account, what its usage read said, and what to do next. */
export function Result(props: Props) {
  const { flow } = props;
  return (
    <VStack gap={3}>
      {flow.account && <Account flow={flow} />}
      {flow.found ? (
        <Text type="body">{t("connect.result.found", { name: credName(flow.account!) })}</Text>
      ) : (
        !flow.account && <Text type="body">{t("connect.result.saved")}</Text>
      )}
      {flow.phase === "refused" ? <Refused {...props} /> : <Connected {...props} />}
    </VStack>
  );
}

/** Result unavailable, failed or cancelled: the reason and a way to start again. */
export function Ended({ flow, signIn, lead }: Props) {
  const unknown = flow.phase === "unknown";
  return (
    <VStack gap={3}>
      {unknown && <Text type="body">{t("connect.ended.unknown")}</Text>}
      {flow.phase === "error" && (
        <Banner
          status="error"
          title={t("connect.ended.failed", { provider: label(flow.provider) })}
          description={flow.problem || undefined}
        />
      )}
      <HStack gap={2} wrap="wrap">
        {unknown && openAccounts("primary", lead)}
        <Button
          ref={unknown ? undefined : lead}
          label={t("connect.ended.again")}
          variant="secondary"
          isLoading={signIn.pending === flow.provider}
          onClick={() => void signIn.start(flow.provider)}
        />
      </HStack>
    </VStack>
  );
}
