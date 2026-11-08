// Use with a tool, on the `form-wizard-dialog` template: Dialog `purpose="form"`, a fill Layout with
// padding 4 and dividers, the title and a compact non-interactive Stepper pinned in the header, one
// step in the content, Back and Continue in the footer, the blocked-step FieldStatus beside
// Continue, and the draft reset when the dialog opens. Deviations, one per line:
// - 800 wide (roles.content.formWidth), not 620: every hosted dialog is 800 (PageDialog), and the
//   setup snippets are code lines that wrap or scroll sooner at 620.
// - One height for every step, PageDialog's (layout.pageDialog), as the template's fixed-height
//   rule asks: the header and footer stay put and only the step's body scrolls.
// - The tool and the key live in the hash (`tool`, `key`), so a key row opens the dialog with its
//   key and old `#use?tool=` links land on their tool; the step stays component state.
// - The last step's primary action is Done, which closes: the result is the test banner, and there
//   is nothing to submit.
// - The key and model pair stacks on phones: the template's horizontal pair has no narrow case,
//   but this dialog fills a 390 px screen.
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FieldStatus } from "@astryxdesign/core/FieldStatus";
import { Icon } from "@astryxdesign/core/Icon";
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  StackItem,
  VStack,
} from "@astryxdesign/core/Layout";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { Plus } from "lucide-react";
import { useConfig, useConfigWrite } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { useHashParams } from "../../app/useHashRoute.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { base } from "../../lib/api/client.ts";
import { newKey } from "../../lib/client-keys.ts";
import { readPath } from "../../lib/config-path.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { isLocalHost, toolTarget } from "./address.ts";
import { ChooseTool } from "./ChooseTool.tsx";
import { TestConnection } from "./TestConnection.tsx";
import { toolFromParam, toolParam } from "./tool.ts";
import { ToolSettings } from "./ToolSettings.tsx";
import { useKeyChoice } from "./useKeyChoice.ts";

const KEYS_PATH = "access/api-keys";
const local = isLocalHost(location.hostname);
const LAST_STEP = 2;

function NoKey({ busy, create }: { busy: boolean; create: () => void }) {
  return (
    <EmptyState
      title={t("use.empty.title")}
      headingLevel={roles.heading.section}
      actions={
        <Button
          label={t("use.empty.create")}
          variant="secondary"
          icon={<Icon icon={Plus} />}
          isLoading={busy}
          onClick={create}
        />
      }
    />
  );
}

/**
 * The step and whether Continue was refused; both start over each time the dialog opens, on the
 * test step when the hash asks for it (`step=test`, from Overview's first run).
 */
function useDraft(isOpen: boolean) {
  const [params] = useHashParams();
  const first = params.step === "test" ? LAST_STEP : 0;
  const [step, setStep] = useState(first);
  const [blocked, setBlocked] = useState(false);
  const [shownOpen, setShownOpen] = useState(isOpen);
  if (shownOpen !== isOpen) {
    setShownOpen(isOpen);
    if (isOpen) {
      setStep(first);
      setBlocked(false);
    }
  }
  return { step, setStep, blocked, setBlocked };
}

function ProgressHeader({
  step,
  onOpenChange,
}: {
  step: number;
  onOpenChange: (open: boolean) => void;
}) {
  const steps = [t("use.steps.tool"), t("use.steps.settings"), t("use.steps.test")];
  return (
    <>
      <DialogHeader title={t("app.nav.use")} onOpenChange={onOpenChange} hasDivider={false} />
      <LayoutHeader hasDivider={false}>
        <Stepper
          activeStep={step}
          orientation="horizontal"
          density="compact"
          label={t("use.steps.label")}
        >
          {steps.map((label, i) => (
            <Step key={label} step={i} label={label} />
          ))}
        </Stepper>
      </LayoutHeader>
    </>
  );
}

function StepFooter({
  step,
  blocked,
  onBack,
  onNext,
}: {
  step: number;
  blocked: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <LayoutFooter>
      <HStack gap={2} vAlign="center">
        <Button
          label={t("use.steps.back")}
          variant="secondary"
          isDisabled={step === 0}
          onClick={onBack}
        />
        <StackItem size="fill" />
        {blocked && (
          <FieldStatus type="error" variant="detached" message={t("use.steps.needKey")} />
        )}
        <Button
          label={step === LAST_STEP ? t("use.steps.done") : t("use.steps.continue")}
          variant={roles.primaryAction.variant}
          onClick={onNext}
        />
      </HStack>
    </LayoutFooter>
  );
}

/** The current step's body; steps 2 and 3 need a key, and a missing one is created here. */
function StepBody({
  step,
  isOpen,
  onCreated,
}: {
  step: number;
  isOpen: boolean;
  onCreated: () => void;
}) {
  const config = useConfig();
  const action = useAction();
  const write = useConfigWrite(action);
  const [params, setParams] = useHashParams();
  const tool = toolFromParam(params.tool);
  // A key the file lacks and an explicit null both show as no keys.
  const keys = config.data ? (readPath(config.data, KEYS_PATH, []) as string[]) : undefined;
  const choice = useKeyChoice(isOpen ? keys : undefined, params.key);
  const create = async () => {
    if (keys && (await write(KEYS_PATH, [...keys, newKey()], t("use.empty.created")))) onCreated();
  };

  if (step === 0)
    return (
      <ChooseTool tool={tool} onTool={(next) => setParams({ tool: toolParam(next) }, "replace")} />
    );
  if (config.isError)
    return (
      <ReadError
        error={config.error}
        what={t("use.page.what")}
        retry={() => void config.refetch()}
      />
    );
  if (keys?.length === 0) return <NoKey busy={action.busy} create={() => void create()} />;
  if (step === 1)
    return (
      <ToolSettings
        tool={tool}
        target={toolTarget(tool, base, local)}
        keys={keys}
        choice={choice}
        onKey={(index) => setParams({ key: String(index) }, "replace")}
        local={local}
      />
    );
  return choice.key ? <TestConnection base={base} clientKey={choice.key} /> : null;
}

export function UseWithTools({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const config = useConfig();
  const { step, setStep, blocked, setBlocked } = useDraft(isOpen);
  const hasKey = !!config.data && (readPath(config.data, KEYS_PATH, []) as string[]).length > 0;
  const onOpenChange = (open: boolean) => !open && onClose();
  const next = () => {
    if (step > 0 && !hasKey) return setBlocked(true);
    if (step === LAST_STEP) return onClose();
    setStep(step + 1);
  };

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      width={roles.content.formWidth}
      maxHeight={layout.pageDialog.height}
      purpose="form"
    >
      <VStack height={layout.pageDialog.height}>
        <Layout
          height="fill"
          padding={4}
          defaultHasDividers
          header={<ProgressHeader step={step} onOpenChange={onOpenChange} />}
          content={
            <LayoutContent>
              <StepBody step={step} isOpen={isOpen} onCreated={() => setBlocked(false)} />
            </LayoutContent>
          }
          footer={
            <StepFooter
              step={step}
              blocked={blocked && !hasKey}
              onBack={() => setStep(Math.max(0, step - 1))}
              onNext={next}
            />
          }
        />
      </VStack>
    </Dialog>
  );
}
