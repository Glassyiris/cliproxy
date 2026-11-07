import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useConfigWrite } from "../../app/serverQueries.ts";
import type { Action } from "../../app/useAction.ts";
import { useKeyTest, type KeyTest } from "../../app/useKeyTest.ts";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { newKey } from "../../lib/client-keys.ts";
import { flag } from "../../lib/first-run.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";

/**
 * The first-run card opens when this server has no accounts and stays, in this browser, until
 * its three steps are done or it is dismissed. A server that already had accounts never shows
 * it. `accounts` is undefined until the accounts read answers.
 */
export function useFirstRun(accounts: number | undefined) {
  const [start, setStart] = useState(() => flag.get("start"));
  if (!start && accounts === 0) setStart("open");
  useEffect(() => {
    if (start) flag.set("start", start);
  }, [start]);
  const finish = useCallback(() => setStart("done"), []);
  const dismiss = useCallback(() => setStart("dismissed"), []);
  return { isOpen: start === "open", finish, dismiss };
}

function TestLine({ result }: { result: KeyTest }) {
  switch (result.status) {
    case "idle":
      return null;
    case "testing":
      return <StatusLamp status="disabled" label={t("overview.start.testing")} />;
    case "ready":
      return (
        <StatusLamp
          status="ready"
          label={t("overview.start.testReady", { count: result.models.length })}
        />
      );
    case "noModels":
      return <StatusLamp status="cooling" label={t("overview.start.testNoModels")} />;
    case "failed":
      return <StatusLamp status="failing" label={result.message} />;
  }
}

type Step = {
  done: boolean;
  title: string;
  text: string;
  action: { label: string; href?: string; run?: () => void; busy?: boolean; off?: boolean };
};

type StepsInput = {
  accounts: number;
  keys: string[];
  served: boolean;
  tested: boolean;
  action: Action;
  createKey: () => void;
  test: { result: KeyTest; run: () => void };
};

/** Connect an account, point a tool at the proxy (or create its key first), send a test. */
function steps({ accounts, keys, served, tested, action, createKey, test }: StepsInput): Step[] {
  const tool: Step = keys.length
    ? {
        done: served || flag.get("start-tool") === "1",
        title: t("overview.start.toolTitle"),
        text: t("overview.start.toolText"),
        action: { label: t("overview.start.useTools"), href: "#use" },
      }
    : {
        done: false,
        title: t("overview.start.toolTitle"),
        text: t("overview.start.keyText"),
        action: { label: t("overview.start.createKey"), busy: action.busy, run: createKey },
      };
  return [
    {
      done: accounts > 0,
      title: t("overview.start.connectTitle"),
      text: t("overview.start.connectText"),
      action: { label: t("overview.page.connect"), href: "#connect" },
    },
    tool,
    {
      done: served || tested,
      title: t("overview.start.testTitle"),
      text: t("overview.start.testText"),
      action: {
        label: t("overview.start.sendTest"),
        busy: test.result.status === "testing",
        off: !keys.length,
        run: test.run,
      },
    },
  ];
}

function StepRow({
  step,
  isPrimary,
  actionRef,
  status,
}: {
  step: Step;
  isPrimary: boolean;
  actionRef?: Ref<HTMLButtonElement>;
  status?: KeyTest;
}) {
  return (
    <ListItem
      label={<Text type="body">{step.title}</Text>}
      description={
        status && status.status !== "idle" ? (
          <VStack role="status">
            <TestLine result={status} />
          </VStack>
        ) : step.done ? undefined : (
          <Text type="supporting" color="secondary">
            {step.text}
          </Text>
        )
      }
      startContent={
        step.done ? (
          <Icon icon="check" size="sm" color="success" label={t("overview.start.done")} />
        ) : (
          <StatusDot variant="neutral" label={t("overview.start.notDone")} />
        )
      }
      endContent={
        !step.done && (
          <Button
            ref={actionRef}
            label={step.action.label}
            size="sm"
            variant={isPrimary ? "primary" : "secondary"}
            href={step.action.href}
            onClick={step.action.run}
            isLoading={step.action.busy}
            isDisabled={step.action.off}
          />
        )
      }
    />
  );
}

function focusHeading() {
  const heading = document.querySelector<HTMLElement>("[role=main] h1");
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus({ focusVisible: false });
}

/**
 * A press that removes or replaces the focused control (a created key turns step 2's button into
 * a link, a passed test removes step 3's) hands focus to the next step's action, or to the page
 * heading once the card is gone. `settle` runs when the steps change; it moves focus only after
 * an armed press and only while focus has fallen back to the document body.
 */
function useFocusHandoff() {
  const next = useRef<HTMLButtonElement>(null);
  const armed = useRef(false);
  const arm = useCallback((press: Promise<unknown>) => {
    armed.current = true;
    void press.then((ok) => {
      // A failed write leaves its button in place.
      if (ok === false) armed.current = false;
    });
  }, []);
  const settle = useCallback(() => {
    if (!armed.current) return;
    armed.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    if (next.current) next.current.focus();
    else focusHeading();
  }, []);
  return { next, arm, settle };
}

function CardHead({
  done,
  total,
  onDismiss,
}: {
  done: number;
  total: number;
  onDismiss: () => void;
}) {
  return (
    <HStack gap={2} vAlign="center">
      <StackItem size="fill">
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Heading level={2}>{t("overview.start.heading")}</Heading>
          <Text type="supporting" color="secondary">
            {t("overview.start.progress", { done, total })}
          </Text>
        </HStack>
      </StackItem>
      <Button
        label={t("overview.start.dismiss")}
        variant="ghost"
        size="sm"
        onClick={() => {
          onDismiss();
          // The card and the pressed button are gone.
          focusHeading();
        }}
      />
    </HStack>
  );
}

export function GetStarted({
  accounts,
  keys,
  served,
  action,
  onFinish,
  onDismiss,
}: {
  accounts: number;
  keys: string[];
  served: boolean;
  action: Action;
  onFinish: () => void;
  onDismiss: () => void;
}) {
  const write = useConfigWrite(action);
  const { result, test } = useKeyTest();
  const { next: nextAction, arm, settle } = useFocusHandoff();
  const [testedBefore] = useState(() => flag.get("start-test") === "1");
  const tested = testedBefore || result.status === "ready";
  const list = steps({
    accounts,
    keys,
    served,
    tested,
    action,
    createKey: () =>
      arm(write("access/api-keys", keys, [...keys, newKey()], t("overview.start.keyCreated"))),
    test: { result, run: () => arm(test(keys[0])) },
  });
  const left = list.filter((s) => !s.done).length;
  const next = list.findIndex((s) => !s.done);
  const shape = list.map((s) => (s.done ? "done" : s.action.label)).join();

  useEffect(() => {
    if (result.status === "ready") flag.set("start-test", "1");
  }, [result]);
  useEffect(settle, [shape, settle]);
  useEffect(() => {
    if (left) return;
    // Only the test can finish the card while it is shown; it then says so once.
    if (result.status === "ready") notify("success", t("overview.start.allSet"));
    onFinish();
  }, [left, result, onFinish]);
  if (!left) return null;

  return (
    <Card padding={4}>
      <VStack gap={2}>
        <CardHead done={list.length - left} total={list.length} onDismiss={onDismiss} />
        <List density="compact" hasDividers>
          {list.map((step, i) => (
            <StepRow
              key={i}
              step={step}
              // Step 1 is the header's Connect account, the page's one primary action.
              isPrimary={i === next && i > 0}
              actionRef={i === next ? nextAction : undefined}
              status={i === 2 ? result : undefined}
            />
          ))}
        </List>
      </VStack>
    </Card>
  );
}
