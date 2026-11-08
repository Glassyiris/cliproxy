import { BellRing } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { RailSection } from "../../components/RailSection.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { lampStatus, lampVariant, stateWord } from "../../components/StatusLamp.tsx";
import { credName } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { LineSkeleton } from "./LineSkeleton.tsx";
import type { Alert, AttentionRow, Summary } from "./summary.ts";

/** The element `npm run measure` checks is in the first screen: the first alert or the all-clear. */
const ANSWER_ID = "overview-attention";
/** The rail lists the most urgent ones; Accounts has every account. */
const SHOWN = 20;

/** What the server says about the account, else its cooldown's status and reason. */
function message({ account, state }: AttentionRow) {
  if (state.detail) return state.detail;
  const cooldown = account.cooldowns?.find((c) => c.scope !== "model");
  if (!cooldown) return undefined;
  return cooldown.http_status
    ? t("overview.attention.cooldownStatus", {
        reason: cooldown.reason,
        status: cooldown.http_status,
      })
    : cooldown.reason;
}

function endWord({ state }: AttentionRow, now: number) {
  return state.state === "limited"
    ? t("overview.attention.limitedUntil", { until: state.until ?? now })
    : stateWord(state, now);
}

function AlertItem({ alert, now }: { alert: Alert; now: number }) {
  if (alert.kind === "noKeys")
    return (
      <ListItem
        href="#keys"
        label={t("overview.attention.noKeys")}
        description={t("overview.attention.noKeysText")}
        startContent={<StatusDot variant="warning" label={t("overview.tiles.attention")} />}
      />
    );
  if (alert.kind === "disabled")
    return (
      <ListItem
        href="#accounts"
        label={t("overview.attention.disabled", { count: alert.count })}
        description={t("overview.attention.disabledText")}
        startContent={<StatusDot variant="neutral" label={t("app.credState.disabled")} />}
      />
    );
  const { row } = alert;
  const word = endWord(row, now);
  return (
    <ListItem
      href={`#accounts/${encodeURIComponent(row.account.id || row.account.name)}`}
      label={credName(row.account)}
      description={message(row)}
      startContent={<StatusDot variant={lampVariant[lampStatus[row.state.lamp]]} label={word} />}
      endContent={
        <Text type="supporting" color="secondary" textWrap="nowrap">
          {word}
        </Text>
      }
    />
  );
}

const alertKey = (a: Alert) =>
  a.kind === "account" ? `${a.row.account.name}\u0000${a.row.account.auth_index}` : a.kind;

function SkeletonRows() {
  return (
    <List density="compact" hasDividers>
      {[0, 1, 2].map((i) => (
        <ListItem
          key={i}
          label={<LineSkeleton role="body" index={i} />}
          description={<LineSkeleton role="supporting" index={i} />}
        />
      ))}
    </List>
  );
}

function Body({ summary, now, inset }: { summary: Summary; now: number; inset: 0 | 4 }) {
  if (!summary.alerts.length)
    return summary.total ? (
      <EmptyState
        title={t("overview.attention.allClear")}
        description={t("overview.attention.allClearText")}
        icon={<Icon icon="success" size="lg" color="success" />}
        isCompact
      />
    ) : (
      <EmptyState
        title={t("overview.attention.nothingYet")}
        description={t("overview.attention.nothingYetText")}
        isCompact
      />
    );
  const hidden = summary.alerts.length - SHOWN;
  return (
    <>
      <List density="compact" hasDividers>
        {summary.alerts.slice(0, SHOWN).map((alert) => (
          <AlertItem key={alertKey(alert)} alert={alert} now={now} />
        ))}
      </List>
      {summary.total > 0 && (
        <VStack paddingBlock={4} paddingInline={inset}>
          <Link href="#accounts?show=attention">
            {hidden > 0
              ? t("overview.attention.more", { count: hidden })
              : t("overview.attention.openAccounts")}
          </Link>
        </VStack>
      )}
    </>
  );
}

/**
 * The template's alert rail: what needs the operator, most urgent first, each row a link to where
 * it is fixed. `summary` is undefined while the accounts load; `reads` are failed reads of the
 * accounts or the configuration, shown above the rows they leave stale or incomplete.
 */
export function AttentionFeed({
  summary,
  now,
  reads,
  hasStickyHeader = false,
}: {
  summary: Summary | undefined;
  now: number;
  reads: { error: unknown; what: string; retry: () => void }[];
  hasStickyHeader?: boolean;
}) {
  const count = summary?.alerts.length ?? 0;
  const failing = summary?.failing ?? 0;
  // The rail form insets its rows already; folded into a card, the section's own lines need it.
  const inset = hasStickyHeader ? 0 : 4;
  return (
    <RailSection
      icon={BellRing}
      iconColor={failing > 0 ? "error" : "secondary"}
      title={t("overview.attention.heading")}
      subtitle={
        !summary
          ? t("overview.tiles.loading")
          : summary.total
            ? t("overview.attention.subtitle", { failing, cooling: summary.cooling.count })
            : t("overview.attention.noAccounts")
      }
      badge={count ? <Badge label={count} variant={failing > 0 ? "error" : "warning"} /> : null}
      hasStickyHeader={hasStickyHeader}
    >
      <VStack gap={0} id={ANSWER_ID}>
        {reads.map((read) => (
          <VStack key={read.what} paddingBlock={4} paddingInline={inset}>
            <ReadError error={read.error} what={read.what} retry={read.retry} />
          </VStack>
        ))}
        {summary ? (
          <Body summary={summary} now={now} inset={inset} />
        ) : (
          !reads.length && <SkeletonRows />
        )}
      </VStack>
    </RailSection>
  );
}
