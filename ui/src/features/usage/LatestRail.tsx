import { History } from "lucide-react";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { RailSection } from "../../components/RailSection.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { t } from "../../lib/i18n.ts";
import type { UsageEvent } from "../../lib/usage.ts";

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
        <VStack padding={4}>
          <StatusLamp status="ready" label={t("usage.rail.listening")} isPulsing />
        </VStack>
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
