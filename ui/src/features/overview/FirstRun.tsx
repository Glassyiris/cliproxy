import { useEffect, useState } from "react";
import { KeyRound, Plug, Send } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ReadError } from "../../components/ReadError.tsx";
import { SectionHeading } from "../../components/SectionHeading.tsx";
import type { Credential } from "../../lib/api/credentials.ts";
import { flag } from "../../lib/first-run.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { LineSkeleton } from "./LineSkeleton.tsx";

/**
 * Where this browser is with the first run: opened when the server had no accounts, then done or
 * dismissed for good. A server that already had accounts never opens it.
 */
type Start = "open" | "done" | "dismissed";

const stored = (): Start | null => {
  const value = flag.get("start");
  return value === "open" || value === "done" || value === "dismissed" ? value : null;
};

const served = (files: Credential[]) => files.some((f) => f.success > 0 || f.failed > 0);

/**
 * The three steps and whether the run shows. `files` and `keys` are undefined while they load;
 * the steps read as done from the server's data, the test from this browser (or any traffic).
 */
export function useFirstRun(files: Credential[] | undefined, keys: number | undefined) {
  const [saved, setSaved] = useState(stored);
  const [isTested] = useState(() => flag.get("start-test") === "1");
  const done =
    files && keys !== undefined
      ? [keys > 0, files.length > 0, isTested || served(files)]
      : undefined;
  const left = done?.filter((d) => !d).length;
  // An empty server opens the run; the last step done closes it.
  let start = saved;
  if (start === null && files?.length === 0) start = "open";
  if (start === "open" && left === 0) start = "done";
  if (start !== saved) setSaved(start);
  useEffect(() => {
    if (start === null || flag.get("start") === start) return;
    flag.set("start", start);
    if (start === "done") notify("success", t("overview.start.allSet"));
  }, [start]);
  return {
    isShown: start === "open" && left !== 0,
    done,
    dismiss: () => setSaved("dismissed"),
  };
}

type Step = {
  title: () => string;
  icon: IconProps["icon"];
  action: () => string;
  /** Where the step is done; connecting goes through the one connect entry instead. */
  href?: string;
};

const steps: Step[] = [
  {
    title: () => t("overview.start.key"),
    icon: KeyRound,
    action: () => t("keys.page.add"),
    href: "#clients?open=new",
  },
  {
    title: () => t("overview.start.connect"),
    icon: Plug,
    action: () => t("overview.page.connect"),
  },
  {
    title: () => t("overview.start.test"),
    icon: Send,
    action: () => t("use.steps.test"),
    href: "#clients?open=use&step=test",
  },
];

const stateWord = {
  done: () => t("overview.start.done"),
  next: () => t("overview.start.next"),
  later: () => t("overview.start.later"),
};

/** One step: its glyph (a check once done), its name, where it stands, and its one action. */
function StepCard({
  step,
  state,
  connect,
}: {
  step: Step;
  state: keyof typeof stateWord | undefined;
  connect: () => void;
}) {
  const isDone = state === "done";
  return (
    <Card padding={roles.card.padding} height="100%">
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" wrap="nowrap">
          <Icon
            icon={isDone ? "success" : step.icon}
            size="sm"
            color={isDone ? "success" : "secondary"}
          />
          <Heading level={roles.heading.inCard} accessibilityLevel={roles.heading.card}>
            {step.title()}
          </Heading>
        </HStack>
        {state === undefined ? (
          <LineSkeleton role="supporting" />
        ) : (
          <Text type={roles.textType.supporting} color="secondary">
            {stateWord[state]()}
          </Text>
        )}
        {!isDone && (
          <HStack hAlign="end">
            <Button
              label={step.action()}
              variant="secondary"
              href={step.href}
              onClick={step.href ? undefined : connect}
            />
          </HStack>
        )}
      </VStack>
    </Card>
  );
}

const columns = { minWidth: layout.settingsColumnMin, max: 3 } as const;

/**
 * Getting started, in the attention cards' place: create a client key, connect an account, send a
 * test request. Each card says whether its step is done or next and opens where it is done.
 */
export function FirstRun({
  done,
  reads,
  connect,
  onDismiss,
}: {
  done: boolean[] | undefined;
  reads: { error: unknown; what: string; retry: () => void }[];
  connect: () => void;
  onDismiss: () => void;
}) {
  const next = done?.indexOf(false) ?? -1;
  return (
    <VStack gap={roles.gap.card}>
      <SectionHeading
        title={t("overview.start.heading")}
        actions={<Button label={t("app.notice.dismiss")} variant="secondary" onClick={onDismiss} />}
      />
      {reads.map((read) => (
        <ReadError key={read.what} error={read.error} what={read.what} retry={read.retry} />
      ))}
      <Grid columns={columns} gap={roles.gap.card}>
        {steps.map((step, i) => (
          <StepCard
            key={i}
            step={step}
            connect={connect}
            state={done && (done[i] ? "done" : i === next ? "next" : "later")}
          />
        ))}
      </Grid>
    </VStack>
  );
}
