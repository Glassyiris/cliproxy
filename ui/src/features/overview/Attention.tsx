import type { ReactNode } from "react";
import { BellRing } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { lampStatus, lampVariant, stateWord } from "../../components/StatusLamp.tsx";
import { credName } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import type { AttentionRow } from "./summary.ts";

const railStyles = stylex.create({
  // Translucent, so the band reads the same on a card and on the panel.
  header: {
    backgroundColor: "var(--color-background-muted)",
  },
  // The opaque layer the translucent band needs; without it the rows read
  // through the header as they scroll past.
  stickyHeader: {
    position: "sticky",
    insetBlockStart: 0,
    zIndex: 1,
    backgroundColor: "var(--color-background-surface)",
  },
});

/**
 * One labelled region of the triage rail. `hasStickyHeader` is the rail form: the header pins to
 * the top of the panel while the list scrolls. Folded inline, the section sits in its own card.
 */
function RailSection({
  icon,
  iconColor,
  title,
  subtitle,
  badge,
  hasStickyHeader = false,
  children,
}: {
  icon: IconProps["icon"];
  iconColor: "error" | "secondary";
  title: string;
  subtitle: string;
  badge: ReactNode;
  hasStickyHeader?: boolean;
  children: ReactNode;
}) {
  return (
    <VStack gap={0}>
      <VStack gap={0} xstyle={hasStickyHeader ? railStyles.stickyHeader : undefined}>
        <VStack gap={1} padding={4} xstyle={railStyles.header}>
          <HStack gap={2} vAlign="center">
            <Icon icon={icon} size="sm" color={iconColor} />
            <StackItem size="fill">
              <Heading level={3} accessibilityLevel={2}>
                {title}
              </Heading>
            </StackItem>
            {badge}
          </HStack>
          {subtitle && (
            <Text type="supporting" color="secondary">
              {subtitle}
            </Text>
          )}
        </VStack>
        <Divider />
      </VStack>
      {children}
    </VStack>
  );
}

/** What the server says about the account, else its cooldown's reason and status. */
function message({ account, state }: AttentionRow) {
  if (state.detail) return state.detail;
  const cooldown = account.cooldowns?.find((c) => c.scope !== "model");
  if (!cooldown) return "";
  return cooldown.http_status
    ? t("overview.attention.cooldownStatus", {
        reason: cooldown.reason,
        status: cooldown.http_status,
      })
    : cooldown.reason;
}

function SkeletonRows() {
  return (
    <List density="compact" hasDividers>
      {[0, 1, 2].map((i) => (
        <ListItem
          key={i}
          label={
            <Skeleton
              width={layout.valueSkeleton.width}
              height={layout.valueSkeleton.height}
              index={i}
            />
          }
        />
      ))}
    </List>
  );
}

function AttentionList({ rows, now }: { rows: AttentionRow[]; now: number }) {
  return (
    <List density="compact" hasDividers>
      {rows.map((row) => {
        const word = stateWord(row.state, now);
        return (
          <ListItem
            key={`${row.account.name}\u0000${row.account.auth_index}`}
            href={`#accounts/${encodeURIComponent(row.account.id || row.account.name)}`}
            label={credName(row.account)}
            description={message(row) || undefined}
            startContent={
              <StatusDot variant={lampVariant[lampStatus[row.state.lamp]]} label={word} />
            }
            endContent={
              <Text type="supporting" color="secondary">
                {word}
              </Text>
            }
          />
        );
      })}
    </List>
  );
}

/** Loading, unreadable, no accounts, none needing attention, or the rows. */
function AttentionBody({
  rows,
  hasAccounts,
  now,
}: {
  rows: AttentionRow[] | null | undefined;
  hasAccounts: boolean;
  now: number;
}) {
  return rows === undefined ? (
    <SkeletonRows />
  ) : rows === null ? (
    <VStack padding={4}>
      <Text type="body" color="secondary">
        {t("overview.attention.unavailable")}
      </Text>
    </VStack>
  ) : !hasAccounts ? (
    <EmptyState
      title={t("overview.attention.noAccounts")}
      headingLevel={3}
      isCompact
      actions={<Button label={t("overview.page.connect")} variant="secondary" href="#connect" />}
    />
  ) : !rows.length ? (
    <EmptyState
      title={t("overview.attention.allReady")}
      headingLevel={3}
      icon={<Icon icon="success" size="lg" color="success" />}
      isCompact
    />
  ) : (
    <AttentionList rows={rows} now={now} />
  );
}

/**
 * Which account needs the operator: failing ones first, then cooling ones by soonest recovery.
 * `rows` is undefined while the accounts load, null when they could not be read (the page
 * banner says so), and `hasAccounts` false on a server with none.
 */
export function AttentionFeed({
  rows,
  hasAccounts,
  now,
  hasStickyHeader = false,
}: {
  rows: AttentionRow[] | null | undefined;
  hasAccounts: boolean;
  now: number;
  hasStickyHeader?: boolean;
}) {
  const failing = rows?.filter((r) => r.state.lamp === "bad").length ?? 0;
  const cooling = (rows?.length ?? 0) - failing;
  return (
    <RailSection
      icon={BellRing}
      iconColor={failing > 0 ? "error" : "secondary"}
      title={t("overview.attention.heading")}
      subtitle={rows && hasAccounts ? t("overview.attention.subtitle", { failing, cooling }) : ""}
      badge={
        rows?.length ? (
          <Badge label={rows.length} variant={failing > 0 ? "error" : "warning"} />
        ) : null
      }
      hasStickyHeader={hasStickyHeader}
    >
      <AttentionBody rows={rows} hasAccounts={hasAccounts} now={now} />
      {hasAccounts && (
        <VStack padding={4}>
          <Link href="#accounts?show=attention">{t("overview.attention.openAccounts")}</Link>
        </VStack>
      )}
    </RailSection>
  );
}
