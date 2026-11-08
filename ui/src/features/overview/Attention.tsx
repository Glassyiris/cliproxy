import { CircleQuestionMark, CloudOff, Gauge, KeyRound, LogIn, PowerOff } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { MetricCard } from "../../components/MetricCard.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { SectionHeading } from "../../components/SectionHeading.tsx";
import { currentLocale, t } from "../../lib/i18n.ts";
import { span } from "../../lib/time.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { LineSkeleton } from "./LineSkeleton.tsx";
import type { Alert, Reason, Summary } from "./summary.ts";

/**
 * `npm run measure` checks the first card (a link in this region) or the all-clear line is in the
 * first screen.
 */
const ANSWER_ID = "overview-attention";

type Tone = "error" | "warning" | "neutral";

const badgeWord: Record<Tone, () => string> = {
  error: () => t("overview.attention.failing"),
  warning: () => t("overview.attention.waiting"),
  neutral: () => t("overview.attention.idle"),
};

const iconColor: Record<Tone, IconProps["color"]> = {
  error: "error",
  warning: "warning",
  neutral: "secondary",
};

/** Each reason in words, its glyph and its tone by the accounts' status. */
const look: Record<
  Reason,
  { title: () => string; hint?: () => string; icon: IconProps["icon"]; tone: Tone }
> = {
  signIn: {
    title: () => t("overview.attention.signIn"),
    icon: LogIn,
    tone: "error",
  },
  unavailable: {
    title: () => t("overview.attention.unavailable"),
    hint: () => t("overview.attention.unavailableHint"),
    icon: CloudOff,
    tone: "error",
  },
  error: {
    title: () => t("overview.attention.error"),
    icon: "error",
    tone: "error",
  },
  limited: {
    title: () => t("overview.attention.limited"),
    icon: Gauge,
    tone: "warning",
  },
  cooling: {
    title: () => t("overview.attention.cooling"),
    icon: "clock",
    tone: "warning",
  },
  disabled: {
    title: () => t("overview.attention.disabled"),
    icon: PowerOff,
    tone: "neutral",
  },
  other: {
    title: () => t("overview.attention.other"),
    icon: CircleQuestionMark,
    tone: "neutral",
  },
};

const count = (n: number) => (
  <Text type={roles.textType.metric} hasTabularNumbers>
    {new Intl.NumberFormat(currentLocale()).format(n)}
  </Text>
);

const basis = (text: string) => (
  <Text type={roles.textType.supporting} color="secondary">
    {text}
  </Text>
);

/**
 * One reason as a card that links to where it is fixed: signing in again opens the connect dialog,
 * the missing client key goes to Clients, the rest go to Accounts filtered to the reason.
 */
function AlertCard({ alert, now }: { alert: Alert; now: number }) {
  if (alert.kind === "noKeys")
    return (
      <MetricCard
        label={t("overview.attention.noKeys")}
        icon={KeyRound}
        iconColor="warning"
        value={count(0)}
        badge={<Badge variant="warning" label={t("overview.attention.unprotected")} />}
        detail={basis(t("overview.attention.noKeysText"))}
        href="#clients"
      />
    );
  const { reason, soonest } = alert;
  const { title, hint, icon, tone } = look[reason];
  const detail =
    soonest === null
      ? hint?.()
      : t("overview.tiles.soonestBack", { time: span(Math.max(0, soonest - now)) });
  return (
    <MetricCard
      label={title()}
      icon={icon}
      iconColor={iconColor[tone]}
      value={count(alert.count)}
      badge={<Badge variant={tone} label={badgeWord[tone]()} />}
      // A line only where the title does not say it all: when the accounts come back, or why.
      detail={detail && basis(detail)}
      href={reason === "signIn" ? "#connect" : `#accounts?show=${reason}`}
    />
  );
}

/** The all-clear, or why there is nothing to judge: one line in place of the cards. */
function Clear({ hasAccounts }: { hasAccounts: boolean }) {
  return (
    <HStack gap={2} vAlign="center" id={`${ANSWER_ID}-clear`}>
      {hasAccounts && <Icon icon="success" size="sm" color="success" />}
      <Text type={roles.textType.body} color={hasAccounts ? "primary" : "secondary"}>
        {hasAccounts ? t("overview.attention.allClear") : t("overview.attention.nothingYet")}
      </Text>
    </HStack>
  );
}

const cards = { minWidth: layout.summaryTileMin, repeat: "fit" } as const;

/**
 * "Needs attention": one card per reason that has accounts, most urgent first (the nbcards admin's
 * "Open work"). `summary` is undefined while the accounts load; `reads` are failed reads of the
 * accounts or the configuration, shown above the cards they leave stale or incomplete.
 */
export function Attention({
  summary,
  now,
  reads,
}: {
  summary: Summary | undefined;
  now: number;
  reads: { error: unknown; what: string; retry: () => void }[];
}) {
  return (
    <VStack gap={roles.gap.card}>
      <SectionHeading title={t("overview.attention.heading")} />
      {reads.map((read) => (
        <ReadError key={read.what} error={read.error} what={read.what} retry={read.retry} />
      ))}
      <VStack id={ANSWER_ID}>
        {!summary ? (
          !reads.length && (
            <Grid columns={cards} gap={roles.gap.card} aria-hidden>
              {[0, 1, 2].map((i) => (
                <MetricCard
                  key={i}
                  // A held line: the label row keeps the height a card's title gives it.
                  label={"\u00a0"}
                  icon="clock"
                  value={<LineSkeleton role="metric" index={i} />}
                  detail={<LineSkeleton role="supporting" index={i} />}
                />
              ))}
            </Grid>
          )
        ) : summary.alerts.length ? (
          <Grid columns={cards} gap={roles.gap.card}>
            {summary.alerts.map((alert) => (
              <AlertCard
                key={alert.kind === "group" ? alert.reason : alert.kind}
                alert={alert}
                now={now}
              />
            ))}
          </Grid>
        ) : (
          <Clear hasAccounts={summary.total > 0} />
        )}
      </VStack>
    </VStack>
  );
}
