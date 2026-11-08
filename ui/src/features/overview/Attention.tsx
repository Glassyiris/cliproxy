import { BellRing } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { RailSection } from "../../components/RailSection.tsx";
import { lampStatus, lampVariant, stateWord } from "../../components/StatusLamp.tsx";
import { credName } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import type { AttentionRow } from "./summary.ts";

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
