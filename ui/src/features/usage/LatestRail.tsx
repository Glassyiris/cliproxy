import type { ReactNode } from "react";
import { History } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { t } from "../../lib/i18n.ts";
import type { UsageEvent } from "../../lib/usage.ts";

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
  title,
  subtitle,
  hasStickyHeader,
  children,
}: {
  icon: IconProps["icon"];
  title: string;
  subtitle: string;
  hasStickyHeader: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <VStack gap={0} xstyle={hasStickyHeader ? railStyles.stickyHeader : undefined}>
        <VStack gap={1} padding={4} xstyle={railStyles.header}>
          <HStack gap={2} vAlign="center">
            <Icon icon={icon} size="sm" color="secondary" />
            <StackItem size="fill">
              <Heading level={3} accessibilityLevel={2}>
                {title}
              </Heading>
            </StackItem>
          </HStack>
          <Text type="supporting" color="secondary">
            {subtitle}
          </Text>
        </VStack>
        <Divider />
      </VStack>
      {children}
    </>
  );
}

const SHOWN = 30;

function EventItem({ event }: { event: UsageEvent }) {
  const word = event.failed ? t("usage.rail.failed") : t("usage.rail.succeeded");
  return (
    <ListItem
      label={<Text type="code">{event.model}</Text>}
      description={
        <Text type="supporting" color="secondary" hasTabularNumbers>
          <Timestamp
            value={new Date(event.at).toISOString()}
            format="system_time"
            type="inherit"
            color="inherit"
          />
          {" · "}
          {event.failed
            ? t("usage.rail.failedLine", { latency: event.latency, status: event.status })
            : t("usage.rail.line", { latency: event.latency, tokens: event.input + event.output })}
        </Text>
      }
      startContent={<StatusDot variant={event.failed ? "error" : "success"} label={word} />}
      endContent={
        event.id && (
          <Text type="code" color="secondary">
            <Link href={`#logs/${encodeURIComponent(event.id)}`}>{event.id}</Link>
          </Text>
        )
      }
    />
  );
}

/** The template's alert rail as the feed of the latest requests this tab took off the queue. */
export function LatestRail({
  events,
  live,
  hasStickyHeader = false,
}: {
  events: UsageEvent[];
  live: boolean;
  hasStickyHeader?: boolean;
}) {
  const latest = events.slice(-SHOWN).reverse();
  return (
    <RailSection
      icon={History}
      title={t("usage.rail.heading")}
      subtitle={t("usage.rail.subtitle", { count: SHOWN })}
      hasStickyHeader={hasStickyHeader}
    >
      {latest.length ? (
        <List density="compact" hasDividers>
          {latest.map((e, i) => (
            <EventItem key={e.id || `${e.at}:${i}`} event={e} />
          ))}
        </List>
      ) : live ? (
        <HStack gap={2} vAlign="center" padding={4}>
          <StatusDot variant="success" label={t("usage.rail.listening")} isPulsing />
          <Text type="supporting" color="secondary">
            {t("usage.rail.listening")}
          </Text>
        </HStack>
      ) : (
        <VStack padding={4}>
          <Text type="supporting" color="secondary">
            {t("usage.rail.off")}
          </Text>
        </VStack>
      )}
    </RailSection>
  );
}
