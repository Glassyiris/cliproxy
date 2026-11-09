// Usage, the Activity route's first tab, from the Astryx template dashboard-comparison on the shared
// PageFrame with the card-v2 admin's sizes (DESIGN.md "Roles"). Deviations from the template, one
// per line with its reason:
// - The header is PageFrame's (route title, then tabs), padded by the page roles, so the h1
//   sits where every page has it; the template's contentWidth 1440 is dropped (content is full).
// - No date-range, segment or device selectors and no Export: the server keeps 200 minutes of
//   ten-minute buckets and nothing to export; the chart card's line names that window instead.
// - The only header control is the live view switch (plan 五: opened from the header, confirmed
//   first), a labelled Switch: an on/off state, and a ghost toggle read as plain text. Reading the
//   usage queue removes records for other readers (REQUIREMENTS Exceptions).
// - No "Key metrics" grid over the 200 minutes: the totals are Overview's tiles and this chart's
//   conclusion, so tiles here would repeat them. MetricCards appear for the live view only.
// - The source filter sits on the chart card, not in the header: it changes that chart only.
// - One chart, a bar chart (TrafficChart) instead of the area trend: requests per ten minutes
//   with failures on top, the shared chart module's form; no sparklines or period deltas, which
//   the API cannot supply.
// - No demographics breakdown cards; the acquisition table becomes the sources table (requests,
//   share with the template's ProgressBar, failed, failed share), flat with row dividers rather
//   than in a Card (COMMON-R "lists and tables are flat"), plus a row toggle that shows that
//   source in the chart.
// - Section headings are SectionHeading (no icon tile): roles "Heading levels".
import { useEffect, useMemo, useRef, useState } from "react";
import { focusManager } from "@tanstack/react-query";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { HStack } from "@astryxdesign/core/Layout";
import { Switch } from "@astryxdesign/core/Switch";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useHashParams } from "../../app/useHashRoute.ts";
import { useAvailable } from "../../components/MissingActions.tsx";
import { routes } from "../../lib/api/routes.ts";
import { t } from "../../lib/i18n.ts";
import { usageStats, type UsageEvent } from "../../lib/usage.ts";
import { layout } from "../../themes/site/layout.ts";
import { LiveSection } from "./Live.tsx";
import { useUsageDrain } from "./queries.ts";
import { addBatch, recent } from "./summary.ts";
import { TrafficSection, useSources } from "./Traffic.tsx";

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
  const traffic = useSources();
  const [params, setParams] = useHashParams();
  const view = useLiveView();
  const stats = useMemo(() => usageStats(view.events), [view.events]);
  const [isAsking, setAsking] = useState(false);
  const isAvailable = useAvailable();
  const canStart = isAvailable(routes.drainUsageQueue);
  const toggle = useRef<HTMLInputElement>(null);
  // Retry and the empty state's Start go with their region; focus goes to the header switch.
  const start = () => {
    view.start();
    toggle.current?.focus();
  };
  const settled = traffic.rows !== undefined || !!traffic.accountRead || !!traffic.keyRead;
  return (
    <PageFrame
      title={t("usage.page.title")}
      width="full"
      actions={
        // Disabled, not hidden, while the queue route is probed or missing, so the header does
        // not move when it is known (REQUIREMENTS Exceptions: probed write actions).
        <HStack height={layout.headerControl} vAlign="center">
          <Switch
            ref={toggle}
            label={t("usage.page.liveSwitch")}
            labelPosition="start"
            value={view.live}
            isDisabled={!view.live && !canStart}
            onChange={(on) => (on ? setAsking(true) : view.stop())}
          />
        </HStack>
      }
    >
      <TrafficSection
        traffic={traffic}
        chosen={params.source ?? ""}
        onChoose={(source) => setParams({ source }, "replace")}
      />
      {/* Under the sources table, whose row count is unknown until it loads: shown once the
          traffic reads answer, so the table's growth moves nothing already on screen. */}
      {settled && (
        <LiveSection
          live={view.live}
          events={view.events}
          stats={stats}
          failure={view.failure}
          onStart={() => setAsking(true)}
          onRetry={start}
          canStart={canStart}
        />
      )}
      <AlertDialog
        isOpen={isAsking}
        onOpenChange={setAsking}
        title={t("usage.start.title")}
        description={t("usage.start.description")}
        actionLabel={t("usage.start.action")}
        cancelLabel={t("usage.start.cancel")}
        onAction={() => {
          setAsking(false);
          start();
        }}
      />
    </PageFrame>
  );
}
