import { useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { CodeColors } from "../../components/CodeEditor.tsx";
import { FormDialog } from "../../components/FormDialog.tsx";
import { t } from "../../lib/i18n.ts";
import { diffText, type Change } from "./settings.ts";

const dotted = (c: Change) => c.setting.path.replaceAll("/", ".");

/** What Save writes, as a diff, and which of it waits for a restart. */
export function ReviewDialog({
  pending,
  busy,
  onSave,
  onDiscard,
  onClose,
}: {
  pending: readonly Change[];
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const [isDiscarding, setDiscarding] = useState(false);
  const restart = pending.filter((c) => c.setting.restart).map(dotted);
  return (
    <FormDialog
      title={t("config.review.title")}
      submitLabel={t("config.review.save", { count: pending.length })}
      busy={busy}
      onSubmit={onSave}
      onClose={onClose}
    >
      <VStack gap={4}>
        {restart.length > 0 && (
          <Banner
            status="warning"
            title={t("config.review.restart", { keys: restart.join(", ") })}
          />
        )}
        <CodeColors>
          <CodeBlock
            code={diffText(pending, t("config.review.unset"))}
            language="yaml"
            isDiff
            hasCopyButton={false}
            width="100%"
          />
        </CodeColors>
        <HStack hAlign="end">
          <Button
            label={t("config.review.discard")}
            variant="ghost"
            isDisabled={busy}
            onClick={() => setDiscarding(true)}
          />
        </HStack>
      </VStack>
      <AlertDialog
        isOpen={isDiscarding}
        onOpenChange={setDiscarding}
        title={t("app.unsaved.title")}
        description={t("config.review.discardHint")}
        actionLabel={t("app.unsaved.discard")}
        cancelLabel={t("app.unsaved.keep")}
        onAction={onDiscard}
      />
    </FormDialog>
  );
}
