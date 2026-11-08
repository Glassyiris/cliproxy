// Connect an account, from the form-wizard-dialog template: which kind of account, and how far
// along is the authorisation? Step 1 chooses the way, step 2 is only that way's flow, step 3 the
// result. Deviations from the template, each with its reason:
// - The dialog frame (Dialog, DialogHeader, 800 wide, one height for every step) is the shell's
//   PageDialog: the Stepper goes in as the page's toolbar, pinned under the title, and the buttons
//   as its footer, so only the step scrolls. Back sits beside the primary at the end, not at the
//   footer's start: every button row in the dashboard ends on the right.
// - A sign-in leaves step 2 by itself when the provider answers, and its footer has no Continue:
//   the operator acts on the provider's page, and the step's one primary is the link there.
// - The API key way hands over to the Provider keys tab's add form, where key groups are stored;
//   it has no step 3 here.
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { FieldStatus } from "@astryxdesign/core/FieldStatus";
import { HStack, StackItem } from "@astryxdesign/core/Layout";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { PageFrame } from "../../app/PageFrame.tsx";
import { useDialogParam } from "../../app/pages/PageDialog.tsx";
import { useAction } from "../../app/useAction.ts";
import type { Family } from "../../components/keyFamilies.ts";
import { t } from "../../lib/i18n.ts";
import { addKeysHref, ApiKeyFamily } from "./ApiKey.tsx";
import { useGone } from "./queries.ts";
import { SignInFlow } from "./SignInFlow.tsx";
import { useSignIn } from "./useSignIn.ts";
import { useVertexImport, VertexFields, VertexResult } from "./Vertex.tsx";
import { Ways, type Way } from "./Ways.tsx";

const steps = [
  () => t("connect.step.way"),
  () => t("connect.step.authorize"),
  () => t("connect.step.result"),
];

/** The wizard's state: the chosen way, the step shown, and the moves between steps. */
function useWizard() {
  const action = useAction();
  const signIn = useSignIn(action);
  const [gone, addGone] = useGone();
  const vertex = useVertexImport(action, () => addGone("vertex"));
  const [way, setWay] = useState<Way | null>(null);
  const [family, setFamily] = useState<Family>("claude");
  const [step, setStep] = useState(0);
  const [unchosen, setUnchosen] = useState(false);
  const { flow } = signIn;
  // A sign-in moves on to its result by itself once the provider has answered.
  const finished =
    way?.kind === "signIn"
      ? !!flow && flow.phase !== "wait"
      : way?.kind === "vertex" && !!vertex.done;
  const at = step === 1 && finished ? 2 : step;
  return {
    signIn,
    vertex,
    gone,
    way,
    family,
    setFamily,
    at,
    unchosen,
    choose: (next: Way) => {
      setWay(next);
      setUnchosen(false);
    },
    back: () => {
      if (at === 1 && way?.kind === "signIn") void signIn.cancel();
      if (way?.kind === "vertex") vertex.reset();
      setStep(0);
    },
    next: async () => {
      if (!way) return setUnchosen(true);
      if (way.kind !== "signIn") return setStep(1);
      if (await signIn.start(way.provider)) setStep(1);
    },
  };
}

type Wizard = ReturnType<typeof useWizard>;

function Body({ wizard }: { wizard: Wizard }) {
  const { at, way, signIn, vertex } = wizard;
  if (at === 0) return <Ways chosen={way} onChoose={wizard.choose} gone={wizard.gone} />;
  if (way?.kind === "signIn")
    return signIn.flow && <SignInFlow flow={signIn.flow} signIn={signIn} />;
  if (way?.kind === "vertex")
    return vertex.done ? <VertexResult done={vertex.done} /> : <VertexFields vertex={vertex} />;
  return <ApiKeyFamily family={wizard.family} onChange={wizard.setFamily} />;
}

/** The footer's one primary: Continue, the way's own action, or Done on the result. */
function Primary({ wizard, onDone }: { wizard: Wizard; onDone: () => void }) {
  const { at, way, signIn, vertex } = wizard;
  if (at === 0)
    return (
      <Button
        label={t("connect.footer.continue")}
        variant="primary"
        isLoading={way?.kind === "signIn" && signIn.pending === way.provider}
        onClick={() => void wizard.next()}
      />
    );
  if (at === 2)
    return <Button label={t("connect.footer.done")} variant="primary" onClick={onDone} />;
  if (way?.kind === "vertex")
    return (
      <Button
        label={t("connect.vertex.import")}
        variant="primary"
        isLoading={vertex.importing}
        onClick={() => void vertex.submit()}
      />
    );
  if (way?.kind === "apiKey")
    return (
      <Button
        label={t("connect.apiKey.next")}
        variant="primary"
        href={addKeysHref(wizard.family)}
      />
    );
  return null;
}

export default function Connect() {
  const wizard = useWizard();
  const dialog = useDialogParam("connect");
  const { at } = wizard;
  const stepper = (
    <Stepper
      activeStep={at}
      orientation="horizontal"
      density="compact"
      label={t("connect.step.label")}
    >
      {steps.map((name, i) => (
        <Step
          key={i}
          step={i}
          label={
            // The API key way's second step picks a provider; it authorises nothing here.
            i === 1 && at > 0 && wizard.way?.kind === "apiKey" ? t("connect.step.provider") : name()
          }
        />
      ))}
    </Stepper>
  );
  const footer = (
    <HStack gap={2} vAlign="center">
      <StackItem size="fill" />
      {at === 0 && wizard.unchosen && (
        <FieldStatus type="error" variant="detached" message={t("connect.footer.chooseFirst")} />
      )}
      <Button
        label={t("connect.footer.back")}
        variant="secondary"
        isDisabled={at === 0}
        onClick={wizard.back}
      />
      <Primary wizard={wizard} onDone={dialog.close} />
    </HStack>
  );
  return (
    <PageFrame title={t("app.nav.connect")} toolbar={stepper} footer={footer}>
      <Body wizard={wizard} />
    </PageFrame>
  );
}
