import {
  BellRing,
  CircleQuestionMark,
  CloudOff,
  Gauge,
  KeyRound,
  LogIn,
  PowerOff,
} from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { RailSection } from "../../components/RailSection.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { stateWord } from "../../components/StatusLamp.tsx";
import { credName } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { LineSkeleton } from "./LineSkeleton.tsx";
import type { Alert, AttentionRow, Reason, Summary } from "./summary.ts";

/** The element `npm run measure` checks is in the first screen: the first row or the all-clear. */
const ANSWER_ID = "overview-attention";
/** An open group lists this many accounts; Accounts has all of them. */
const SHOWN = 5;

const failing = "#accounts?show=attention";
const viewAccounts = () => t("overview.attention.viewAccounts");

/** Each reason in words, its glyph, its colour by the accounts' status, and the one action. */
const look: Record<
  Reason,
  {
    title: () => string;
    icon: IconProps["icon"];
    color: IconProps["color"];
    action: () => string;
    href: string;
  }
> = {
  signIn: {
    title: () => t("overview.attention.signIn"),
    icon: LogIn,
    color: "error",
    action: () => t("overview.attention.signInAgain"),
    href: "#connect",
  },
  unavailable: {
    title: () => t("overview.attention.unavailable"),
    icon: CloudOff,
    color: "error",
    action: viewAccounts,
    href: failing,
  },
  error: {
    title: () => t("overview.attention.error"),
    icon: "error",
    color: "error",
    action: viewAccounts,
    href: failing,
  },
  limited: {
    title: () => t("overview.attention.limited"),
    icon: Gauge,
    color: "warning",
    action: viewAccounts,
    href: "#accounts",
  },
  cooling: {
    title: () => t("overview.attention.cooling"),
    icon: "clock",
    color: "warning",
    action: viewAccounts,
    href: "#accounts",
  },
  disabled: {
    title: () => t("overview.attention.disabled"),
    icon: PowerOff,
    color: "secondary",
    action: viewAccounts,
    href: "#accounts",
  },
  other: {
    title: () => t("overview.attention.other"),
    icon: CircleQuestionMark,
    color: "secondary",
    action: viewAccounts,
    href: "#accounts",
  },
};

/** The group's list goes to all of its accounts; signing in again starts from the connect page. */
const allHref = (reason: Reason) => (reason === "signIn" ? failing : look[reason].href);

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

/** The time an account waits for, or the server's own status; the group already names the rest. */
function endWord({ state }: AttentionRow, now: number) {
  if (state.state === "limited")
    return t("overview.attention.limitedUntil", { until: state.until ?? now });
  if (state.state === "cooling" || state.state === "other") return stateWord(state, now);
  return undefined;
}

/** The row's first line: what is wrong, and the one action at its end. */
function Title({ text, action, href }: { text: string; action: string; href: string }) {
  return (
    <HStack gap={3} vAlign="center" wrap="nowrap">
      <StackItem size="fill">
        <Text>{text}</Text>
      </StackItem>
      <Link href={href}>{action}</Link>
    </HStack>
  );
}

function Accounts({ rows, reason, now }: { rows: AttentionRow[]; reason: Reason; now: number }) {
  return (
    <VStack gap={2}>
      <List density="compact">
        {rows.slice(0, SHOWN).map((row) => {
          const word = endWord(row, now);
          return (
            <ListItem
              key={`${row.account.name}\u0000${row.account.auth_index}`}
              href={`#accounts/${encodeURIComponent(row.account.id || row.account.name)}`}
              label={credName(row.account)}
              description={message(row)}
              endContent={
                word && (
                  <Text type="supporting" color="secondary" textWrap="nowrap">
                    {word}
                  </Text>
                )
              }
            />
          );
        })}
      </List>
      {rows.length > SHOWN && (
        <Link href={allHref(reason)}>
          {t("overview.attention.viewAll", { count: rows.length })}
        </Link>
      )}
    </VStack>
  );
}

function AlertItem({ alert, now }: { alert: Alert; now: number }) {
  if (alert.kind === "noKeys")
    return (
      <ListItem
        align="first-line"
        startContent={<Icon icon={KeyRound} size="sm" color="warning" />}
        label={
          <Title
            text={t("overview.attention.noKeys")}
            action={t("overview.attention.addKey")}
            href="#keys"
          />
        }
        description={t("overview.attention.noKeysText")}
      />
    );
  const { reason, rows } = alert;
  const { title, icon, color, action, href } = look[reason];
  return (
    <ListItem
      align="first-line"
      startContent={<Icon icon={icon} size="sm" color={color} />}
      label={<Title text={title()} action={action()} href={href} />}
      description={
        <Collapsible
          defaultIsOpen={false}
          trigger={
            <Text type="supporting" color="secondary" hasTabularNumbers>
              {t("overview.attention.accounts", { count: rows.length })}
            </Text>
          }
        >
          <Accounts rows={rows} reason={reason} now={now} />
        </Collapsible>
      }
    />
  );
}

const alertKey = (a: Alert) => (a.kind === "group" ? a.reason : a.kind);

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

function Body({ summary, now }: { summary: Summary; now: number }) {
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
  return (
    <List hasDividers>
      {summary.alerts.map((alert) => (
        <AlertItem key={alertKey(alert)} alert={alert} now={now} />
      ))}
    </List>
  );
}

/**
 * The template's alert rail: one row per reason, most urgent first, each with its one action and
 * the affected accounts behind a disclosure. `summary` is undefined while the accounts load;
 * `reads` are failed reads of the accounts or the configuration, shown above the rows they leave
 * stale or incomplete.
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
  const failingCount = summary?.failing ?? 0;
  // The rail form insets its rows already; folded into a card, the section's own lines need it.
  const inset = hasStickyHeader ? 0 : 4;
  return (
    <RailSection
      icon={BellRing}
      iconColor={failingCount > 0 ? "error" : "secondary"}
      title={t("overview.attention.heading")}
      subtitle={
        !summary
          ? t("overview.tiles.loading")
          : summary.total
            ? t("overview.attention.subtitle", {
                failing: failingCount,
                cooling: summary.cooling.count,
              })
            : t("overview.attention.noAccounts")
      }
      badge={
        count ? <Badge label={count} variant={failingCount > 0 ? "error" : "warning"} /> : null
      }
      hasStickyHeader={hasStickyHeader}
    >
      <VStack gap={0} id={ANSWER_ID}>
        {reads.map((read) => (
          <VStack key={read.what} paddingBlock={4} paddingInline={inset}>
            <ReadError error={read.error} what={read.what} retry={read.retry} />
          </VStack>
        ))}
        {summary ? <Body summary={summary} now={now} /> : !reads.length && <SkeletonRows />}
      </VStack>
    </RailSection>
  );
}
