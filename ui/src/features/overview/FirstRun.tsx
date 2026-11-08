import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Step as StepperStep, Stepper } from "@astryxdesign/core/Stepper";
import { Heading, Text } from "@astryxdesign/core/Text";
import { icons } from "../../components/icons.ts";
import { ReadError } from "../../components/ReadError.tsx";
import type { Credential } from "../../lib/api/credentials.ts";
import { flag } from "../../lib/firstRun.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
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
  line: () => string;
  action: () => string;
  icon: (typeof icons)[keyof typeof icons];
  /** Where the step is done; connecting goes through the one connect entry instead. */
  href?: string;
};

const steps: Step[] = [
  {
    title: () => t("overview.start.key"),
    line: () => t("overview.start.keyLine"),
    action: () => t("keys.page.add"),
    icon: icons.add,
    href: "#clients?open=new",
  },
  {
    title: () => t("overview.start.connect"),
    line: () => t("overview.start.connectLine"),
    action: () => t("overview.page.connect"),
    icon: icons.add,
  },
  {
    title: () => t("overview.start.test"),
    line: () => t("overview.start.testLine"),
    action: () => t("use.steps.test"),
    icon: icons.test,
    href: "#clients?open=use&step=test",
  },
];

/** The card's title row: the heading, how many steps are done, and the low-key way out. */
function Header({ count, onDismiss }: { count: number | undefined; onDismiss: () => void }) {
  return (
    <HStack hAlign="between" vAlign="center" gap={3} wrap="wrap">
      <Heading level={roles.heading.card} accessibilityLevel={roles.heading.section}>
        {t("overview.start.heading")}
      </Heading>
      <HStack gap={2} vAlign="center" wrap="nowrap">
        {count === undefined ? (
          <LineSkeleton role="supporting" />
        ) : (
          <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
            {t("overview.start.progress", { done: count, total: steps.length })}
          </Text>
        )}
        <Button
          label={t("overview.start.skip")}
          variant={roles.rowAction.variant}
          size={roles.rowAction.size}
          onClick={onDismiss}
        />
      </HStack>
    </HStack>
  );
}

/**
 * Getting started, in the attention cards' place: one card listing the three steps in order
 * (create a client key, connect an account, send a test request), after the onboarding pattern
 * of a vertical Stepper. Only the next step carries its action; the steps after it wait muted, and
 * a done step shows its check wherever it sits, since the test can pass before the key exists.
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
  // A step finished here moves focus on to the next step's action, so a keyboard user keeps going.
  const action = useRef<HTMLButtonElement>(null);
  const shownNext = useRef(next);
  useEffect(() => {
    if (shownNext.current !== -1 && next > shownNext.current) action.current?.focus();
    shownNext.current = next;
  }, [next]);
  return (
    <VStack as="section" gap={roles.gap.card}>
      {reads.map((read) => (
        <ReadError key={read.what} error={read.error} what={read.what} retry={read.retry} />
      ))}
      <Card padding={roles.card.padding}>
        <VStack gap={roles.gap.card}>
          <Header count={done?.filter(Boolean).length} onDismiss={onDismiss} />
          <Stepper
            orientation="vertical"
            // While the steps load none is current, so none draws as done or next.
            activeStep={next}
            label={t("overview.start.heading")}
          >
            {steps.map((step, i) => {
              const isDone = done?.[i] === true;
              return (
                <StepperStep
                  key={i}
                  step={i}
                  label={step.title()}
                  description={step.line()}
                  status={isDone ? "success" : undefined}
                  indicator={isDone ? <Icon icon={icons.allClear} color="success" /> : "auto"}
                >
                  {i === next && (
                    <HStack>
                      <Button
                        ref={action}
                        label={step.action()}
                        variant={roles.primaryAction.variant}
                        icon={<Icon icon={step.icon} />}
                        href={step.href}
                        onClick={step.href ? undefined : connect}
                      />
                    </HStack>
                  )}
                </StepperStep>
              );
            })}
          </Stepper>
        </VStack>
      </Card>
    </VStack>
  );
}
