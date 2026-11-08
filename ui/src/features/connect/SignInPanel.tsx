import { useEffect, useRef } from "react";
import { Card } from "@astryxdesign/core/Card";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { span } from "../../lib/time.ts";
import { phaseStatus } from "./flow.ts";
import { Ended, Result, Verifying } from "./Result.tsx";
import type { Flow, SignIn } from "./useSignIn.ts";
import { Waiting } from "./Waiting.tsx";
import { phaseWord } from "./words.ts";

function Expiry({ flow, polledAt }: { flow: Flow; polledAt: number }) {
  if (flow.phase !== "wait" || !flow.expiresAt) return null;
  const left = flow.expiresAt - Math.max(polledAt, flow.at);
  return (
    <Text type="supporting" color="secondary">
      {left > 0 ? t("connect.panel.expiresIn", { time: span(left) }) : t("connect.panel.expired")}
    </Text>
  );
}

/** The current sign-in, from waiting for approval to its result. */
export function SignInPanel({ signIn }: { signIn: SignIn }) {
  const { flow } = signIn;
  // The control to land on: the sign-in link when a sign-in starts, and the next step's first
  // button when the focused control went away with the previous step. A step with no button
  // (Verifying) lands on the panel's heading, and its first button takes over from there.
  const lead = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = flow?.id;
  const phase = flow?.phase;
  useEffect(() => {
    if (id) lead.current?.focus();
  }, [id]);
  useEffect(() => {
    const at = document.activeElement;
    if (at === document.body || at === heading.current) (lead.current ?? heading.current)?.focus();
  }, [phase]);
  if (!flow) return null;
  const waiting = flow.phase === "wait";
  const result = waiting ? null : flow.phase === "verifying" ? (
    <Verifying flow={flow} />
  ) : flow.phase === "ok" || flow.phase === "refused" ? (
    <Result flow={flow} signIn={signIn} lead={lead} />
  ) : (
    <Ended flow={flow} signIn={signIn} lead={lead} />
  );
  // Only the phase word and the result are announced; the expiry countdown and the waiting
  // steps stay out of the live regions. Waiting is keyed by its sign-in, so a replacing sign-in
  // starts with an empty callback form.
  return (
    <Card>
      <VStack gap={4}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StackItem size="fill">
            <Heading level={3} ref={heading} tabIndex={-1}>
              {label(flow.provider)}
            </Heading>
          </StackItem>
          <Expiry flow={flow} polledAt={signIn.polledAt} />
          <HStack aria-live="polite">
            <StatusLamp
              status={phaseStatus[flow.phase]}
              label={phaseWord(flow.phase)}
              isPulsing={waiting}
            />
          </HStack>
        </HStack>
        <VStack>
          {waiting && <Waiting key={flow.id} flow={flow} signIn={signIn} lead={lead} />}
          <VStack aria-live="polite">{result}</VStack>
        </VStack>
      </VStack>
    </Card>
  );
}
