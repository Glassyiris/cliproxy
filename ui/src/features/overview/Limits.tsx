import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useQuota } from "../../app/QuotaProvider.tsx";
import type { Action } from "../../app/useAction.ts";
import { MissingActions, useAvailable } from "../../components/MissingActions.tsx";
import { QuotaWindow } from "../../components/QuotaWindow.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import type { Credential } from "../../lib/api/credentials.ts";
import { routes } from "../../lib/api/routes.ts";
import { credName, credState, label, provider, type Limits } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { ago } from "../../lib/time.ts";
import { layout } from "../../themes/site/layout.ts";

type Quota = ReturnType<typeof useQuota>;

/** Provider, when the numbers were read and by whom, or that a check is on its way. */
function meta(a: Credential, l: Limits, quota: Quota, now: number) {
  const pending = quota.pending(a);
  if (pending)
    return pending === "checking" ? t("overview.limits.checking") : t("overview.limits.queued");
  const at = l && "at" in l ? l.at : 0;
  if (!at) return label(provider(a));
  // A reading of this tab's own is a check; anything else the server saw on real traffic.
  const live = quota.reading(a);
  const values = { provider: label(provider(a)), age: ago(at, now) };
  return live && "windows" in live
    ? t("overview.limits.checked", values)
    : t("overview.limits.seen", values);
}

function LimitRow({
  account,
  limits,
  quota,
  now,
}: {
  account: Credential;
  limits: Limits;
  quota: Quota;
  now: number;
}) {
  const windows = limits && "windows" in limits ? limits.windows : [];
  // Numbers kept past a refused sign-in are dated, as on Accounts.
  const at = limits && "at" in limits ? limits.at : 0;
  const staleFor = credState(account, now).state === "signIn" && windows.length ? now - at : null;
  return (
    <ListItem
      href={`#accounts/${encodeURIComponent(account.id || account.name)}`}
      label={credName(account)}
      description={
        <VStack gap={2}>
          <Text type="supporting" color="secondary">
            {meta(account, limits, quota, now)}
          </Text>
          {windows.length > 0 && (
            <Grid columns={{ minWidth: layout.summaryTileMin, repeat: "fit" }} gap={4}>
              {windows.map((w, i) => (
                <QuotaWindow key={i} bar={{ window: w, staleFor }} now={now} />
              ))}
            </Grid>
          )}
          {limits?.error && <StatusLamp status="failing" label={limits.error} />}
        </VStack>
      }
    />
  );
}

/**
 * Accounts with a quota reading, passive or from this tab's checks, and those waiting for their
 * first; checks run only on press. Without the provider-call route, Check limits stays, disabled.
 */
export function LimitsSection({
  files,
  now,
  action,
}: {
  files: Credential[];
  now: number;
  action: Action;
}) {
  const quota = useQuota();
  const isAvailable = useAvailable();
  const rows = files.flatMap((account) => {
    const limits = quota.limits(account);
    return limits || quota.pending(account) ? [{ account, limits }] : [];
  });
  const checkable = files.some(quota.canCheck);
  const routeMissing = !isAvailable(routes.callProvider) && files.some((a) => !a.disabled);
  if (!rows.length && !checkable && !routeMissing) return null;
  const checkLimits = () =>
    void action.run(async () => {
      const due = files.filter((a) => quota.canCheck(a) && !quota.wait(a));
      await quota.checkAll(due);
      notify("info", t("overview.limits.checkedCount", { count: due.length }));
    });
  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
        <Heading level={2}>{t("overview.limits.heading")}</Heading>
        {(checkable || routeMissing) && (
          <Button
            label={t("overview.limits.check")}
            variant="secondary"
            size="sm"
            isLoading={action.busy}
            isDisabled={!checkable}
            onClick={checkLimits}
          />
        )}
      </HStack>
      {!checkable && (
        <MissingActions
          actions={[{ route: routes.callProvider, label: t("overview.limits.check") }]}
        />
      )}
      {rows.length ? (
        <List density="compact" hasDividers>
          {rows.map(({ account, limits }) => (
            <LimitRow
              key={`${account.name}\u0000${account.auth_index}`}
              account={account}
              limits={limits}
              quota={quota}
              now={now}
            />
          ))}
        </List>
      ) : (
        <EmptyState title={t("overview.limits.empty")} headingLevel={3} isCompact />
      )}
    </VStack>
  );
}
