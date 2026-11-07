import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { focusManager } from "@tanstack/react-query";
import { Play, Square } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useApiKeyUsage, useCredentials } from "../../app/serverQueries.ts";
import { MissingActions, useAvailable } from "../../components/MissingActions.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { routes } from "../../lib/api/routes.ts";
import { t } from "../../lib/i18n.ts";
import { usageStats, type UsageEvent } from "../../lib/usage.ts";
import { LatestRail } from "./LatestRail.tsx";
import { LiveTiles, ModelTable } from "./LiveTiles.tsx";
import { useUsageDrain } from "./queries.ts";
import { SourcesCard } from "./Sources.tsx";
import { addBatch, recent, sources } from "./summary.ts";

// 1024px at the default root size, where the template folds its rail into the content.
const RAIL_FOLDS = "(max-width: 64rem)";

/**
 * The template's header status line: a pulsing lamp while the live view drains the queue.
 * ponytail: StatusLamp has no pulse; this draws the same lamp and word with StatusDot until it does.
 */
function LiveLamp({ live }: { live: boolean }) {
  const word = live ? t("usage.page.live") : t("usage.page.off");
  return (
    <HStack gap={1.5} vAlign="center">
      <StatusDot variant={live ? "success" : "neutral"} label={word} isPulsing={live} />
      <Text type="supporting" color="secondary">
        {word}
      </Text>
    </HStack>
  );
}

/**
 * Start live view or Stop. A primary button is never greyed out, so without the queue route the
 * page shows no Start and MissingActions names it.
 */
function LiveToggle({
  ref,
  live,
  onPress,
}: {
  ref: Ref<HTMLButtonElement>;
  live: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      ref={ref}
      label={live ? t("usage.page.stop") : t("usage.page.start")}
      variant="primary"
      icon={<Icon icon={live ? Square : Play} />}
      onClick={onPress}
    />
  );
}

/** Both traffic reads; a failed poll keeps the cached answer, so a failure drops its rows. */
function useSources() {
  const credentials = useCredentials({ poll: true });
  const keyUsage = useApiKeyUsage({ poll: true });
  const files = credentials.isError ? null : credentials.data?.files;
  const usage = keyUsage.isError ? null : keyUsage.data;
  const summary = useMemo(
    () => (files === undefined || usage === undefined ? undefined : sources(files, usage)),
    [files, usage],
  );
  return {
    summary,
    accountRead: credentials.isError
      ? { error: credentials.error, retry: () => void credentials.refetch() }
      : null,
    keyRead: keyUsage.isError
      ? { error: keyUsage.error, retry: () => void keyUsage.refetch() }
      : null,
  };
}

const CLOCK_MS = 10_000;

/** The time, advanced every 10 s while the tab is shown and as soon as it is shown again. */
function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (focusManager.isFocused()) setNow(Date.now());
    };
    const timer = setInterval(tick, CLOCK_MS);
    const unsubscribe = focusManager.subscribe(tick);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, []);
  return now;
}

/**
 * The opt-in live view: the events this tab took off the queue in the last hour, by the page's
 * clock so they expire while stopped too, and why it last stopped.
 */
function useLiveView() {
  const [live, setLive] = useState(false);
  const [held, setHeld] = useState<UsageEvent[]>([]);
  const now = useClock();
  const events = useMemo(() => recent(held, now), [held, now]);
  const [failure, setFailure] = useState<unknown>(null);
  useUsageDrain({
    live,
    onBatch: (batch) => setHeld((list) => addBatch(list, batch, Date.now())),
    onError: (error) => {
      setLive(false);
      setFailure(error);
    },
  });
  const start = () => {
    setFailure(null);
    setLive(true);
  };
  return { live, events, failure, start, stop: () => setLive(false) };
}

export default function Usage() {
  const { summary, accountRead, keyRead } = useSources();
  const view = useLiveView();
  const stats = useMemo(() => usageStats(view.events), [view.events]);
  const [isAsking, setAsking] = useState(false);
  const isAvailable = useAvailable();
  const isNarrow = useMediaQuery(RAIL_FOLDS);
  const toggle = useRef<HTMLButtonElement>(null);
  // Retry removes the banner that holds it, so focus goes to the header button.
  const retry = () => {
    view.start();
    toggle.current?.focus();
  };
  const rail = (hasStickyHeader: boolean) => (
    <LatestRail events={view.events} live={view.live} hasStickyHeader={hasStickyHeader} />
  );

  return (
    <PageFrame
      title={t("usage.page.title")}
      width="full"
      meta={<LiveLamp live={view.live} />}
      actions={
        (view.live || isAvailable(routes.drainUsageQueue)) && (
          <LiveToggle
            ref={toggle}
            live={view.live}
            onPress={() => (view.live ? view.stop() : setAsking(true))}
          />
        )
      }
      panel={
        isNarrow
          ? undefined
          : {
              label: t("usage.rail.heading"),
              content: rail(true),
              onClose: () => {},
            }
      }
    >
      <VStack gap={10}>
        {view.failure !== null && (
          <ReadError error={view.failure} what={t("usage.page.liveRead")} retry={retry} />
        )}
        <MissingActions
          actions={[{ route: routes.drainUsageQueue, label: t("usage.page.liveAction") }]}
        />
        <SourcesCard
          rows={summary?.rows}
          max={summary?.max ?? 1}
          accountRead={accountRead}
          keyRead={keyRead}
        />
        {stats.count > 0 && (
          <>
            <Divider />
            <LiveTiles stats={stats} />
            <ModelTable models={stats.models} />
          </>
        )}
        {isNarrow && <Card padding={0}>{rail(false)}</Card>}
      </VStack>
      <AlertDialog
        isOpen={isAsking}
        onOpenChange={setAsking}
        title={t("usage.start.title")}
        description={t("usage.start.description")}
        actionLabel={t("usage.start.action")}
        cancelLabel={t("usage.start.cancel")}
        onAction={() => {
          setAsking(false);
          view.start();
        }}
      />
    </PageFrame>
  );
}
