// Edit a config value as JSON in a form dialog. Review shows the change as a diff, and Save
// refuses when the server value changed since the editor opened.
// Template: the DialogFormDialog block: Dialog `purpose="form"`, a Layout with the DialogHeader,
// the content, and Cancel beside the primary action at the end of a LayoutFooter; only the content
// scrolls. Deviation: the preferences dialog's size (layout.settingsDialog), not the block's 480,
// for every editor, since code lines are long.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Icon } from "@astryxdesign/core/Icon";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { icons } from "./icons.ts";
import { serverKeys } from "../app/serverQueries.ts";
import { failureNotice, type Action } from "../app/useAction.ts";
import { useUnsavedChanges } from "../app/useHashRoute.ts";
import { ConfigChangedError, readConfigValue, replaceConfigValue } from "../lib/api/config.ts";
import { lineDiff } from "../lib/compare.ts";
import { configSaveFailure } from "../lib/configSaveFailure.ts";
import { t } from "../lib/i18n.ts";
import { notify } from "../lib/notify.ts";
import { layout } from "../themes/site/layout.ts";
import { CodeColors, CodeEditor } from "./CodeEditor.tsx";
import { FormDialogHeader } from "./FormDialog.tsx";
import { ReadError } from "./ReadError.tsx";

/** A config key path such as "routing/strategy", edited as JSON. */
type ConfigSource = { path: string };

/** What the editor opens for an absent key: an empty object, told apart by identity. */
const absent = {};

const diffText = (before: string, after: string) =>
  lineDiff(before, after)
    .map((l) => `${l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " "}${l.text}`)
    .join("\n");

/**
 * Edit `source`; `onClose` runs after a save or when the user leaves without one. Save runs
 * through the page's `action`, so the editor and the page's other writes go one at a time.
 */
export function ConfigEditor({
  source,
  title,
  hashKey,
  action,
  onClose,
}: {
  source: ConfigSource | null;
  title: string;
  /** The query key that holds the editor open, so Back asks before it drops unsaved text. */
  hashKey: string;
  action: Action;
  onClose: () => void;
}) {
  if (!source) return null;
  return (
    <Editor
      key={source.path}
      source={source}
      title={title}
      hashKey={hashKey}
      action={action}
      onClose={onClose}
    />
  );
}

function useEditor(source: ConfigSource, action: Action, hashKey: string, onSaved: () => void) {
  const read = useQuery({
    queryKey: ["config-editor", source.path],
    queryFn: ({ signal }) => readConfigValue(source.path, { signal, fallback: absent }),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const editor = useJsonEditor(source.path, read, read.data, action, hashKey, onSaved, (spec) =>
    replaceConfigValue(source.path, read.data, spec, absent),
  );
  return { ...editor, isAbsent: read.data === absent };
}

/** Shared JSON review, refusal handling and unsaved-change protection. */
function useJsonEditor(
  path: string,
  read: UseQueryResult<unknown, Error>,
  baseline: unknown,
  action: Action,
  hashKey: string,
  onSaved: () => void,
  write: (spec: unknown) => Promise<unknown>,
  onReset: () => void = () => {},
) {
  const before = read.isSuccess ? JSON.stringify(baseline, null, 2) : "";
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? before;
  const isDirty = text !== before;
  const release = useUnsavedChanges(isDirty, hashKey);
  const saving = useSave({ path }, write, action, {
    // The saved text is the new server copy, and the next edit starts from it.
    onSaved: () => {
      setDraft(null);
      void read.refetch();
      onReset();
      release();
      onSaved();
    },
    // The draft stays, so Review shows it against the new server copy.
    onRefused: () => {
      void read.refetch();
      onReset();
    },
    onRejected: setDraft,
  });
  return {
    read,
    before,
    text,
    isDirty,
    setDraft,
    release,
    ...saving,
  };
}

type EditorState = {
  read: UseQueryResult<unknown, Error>;
  before: string;
  text: string;
  isDirty: boolean;
  setDraft: (draft: string) => void;
  release: () => void;
  save: (next: string) => Promise<void>;
  isSaving: boolean;
  error: string;
  isAbsent?: boolean;
  prompt?: (header: ReactNode, onCancel: () => void) => ReactNode;
};

function EditorContent({
  title,
  header,
  editor,
  onCancel,
}: {
  title: string;
  header: ReactNode;
  editor: EditorState;
  onCancel: () => void;
}) {
  const { read } = editor;
  if (read.isPending || read.isError)
    return (
      <Layout
        header={header}
        content={
          <LayoutContent>
            {read.isPending ? (
              <Center axis="both" padding={10}>
                <Spinner aria-label={t("app.read.loading", { what: title })} />
              </Center>
            ) : (
              <ReadError error={read.error} what={title} retry={() => void read.refetch()} />
            )}
          </LayoutContent>
        }
      />
    );
  if (editor.prompt) return editor.prompt(header, onCancel);
  // Keyed on the server copy, so a save or a refusal returns to the text from review.
  return (
    <EditorBody
      key={editor.before}
      header={header}
      before={editor.before}
      text={editor.text}
      onEdit={editor.setDraft}
      onCancel={onCancel}
      save={editor.save}
      isSaving={editor.isSaving}
      error={editor.error}
    />
  );
}

function Editor({
  source,
  title,
  hashKey,
  action,
  onClose,
}: {
  source: ConfigSource;
  title: string;
  hashKey: string;
  action: Action;
  onClose: () => void;
}) {
  const editor = useEditor(source, action, hashKey, onClose);
  return <JsonEditorDialog path={source.path} title={title} editor={editor} onClose={onClose} />;
}

function JsonEditorDialog({
  path,
  title,
  editor,
  onClose,
}: {
  path: string;
  title: string;
  editor: EditorState;
  onClose: () => void;
}) {
  const [isAsking, setAsking] = useState(false);
  // A save cannot be called back once sent, so the editor stays open until it ends.
  const close = () => !editor.isSaving && (editor.isDirty ? setAsking(true) : onClose());
  const discard = () => {
    editor.release();
    onClose();
  };
  const subtitle =
    title !== path ? (
      <Text type="code">{path}</Text>
    ) : editor.isAbsent ? (
      t("app.editor.absent")
    ) : undefined;

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && close()}
      width={layout.settingsDialog.width}
      maxHeight={layout.settingsDialog.height}
      purpose="form"
    >
      <EditorContent
        title={title}
        header={
          <FormDialogHeader
            title={title}
            subtitle={subtitle}
            busy={editor.isSaving}
            onClose={close}
          />
        }
        editor={editor}
        onCancel={close}
      />
      <AlertDialog
        isOpen={isAsking}
        onOpenChange={setAsking}
        title={t("app.unsaved.title")}
        description={t("app.editor.discardDescription")}
        actionLabel={t("app.unsaved.discard")}
        cancelLabel={t("app.unsaved.keep")}
        onAction={discard}
      />
    </Dialog>
  );
}

/**
 * Save one reviewed text through the page's action. A refused save (the server copy changed) is
 * the action's error toast; any other failure stays in the dialog, beside what it refused. Once
 * the editor is gone, an answer still on its way changes nothing in it.
 */
function useSave(
  source: ConfigSource,
  write: (spec: unknown) => Promise<unknown>,
  action: Action,
  then: { onSaved: () => void; onRefused: () => void; onRejected: (draft: string) => void },
) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [isSaving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  const save = async (next: string) => {
    let saved = false;
    await action.run(async () => {
      setSaving(true);
      setError("");
      try {
        await write(JSON.parse(next));
        saved = true;
      } catch (e) {
        if (!mounted.current) return;
        if (e instanceof ConfigChangedError) {
          then.onRefused();
          throw e;
        }
        const failure = configSaveFailure(e, next);
        setError(failure?.message ?? failureNotice(e)?.message ?? "");
        if (failure) then.onRejected(failure.draft);
      } finally {
        if (mounted.current) setSaving(false);
        await queryClient.invalidateQueries({ queryKey: serverKeys.config });
      }
    });
    if (!saved || !mounted.current) return;
    notify("success", t("app.editor.saved"));
    then.onSaved();
  };
  return { save, isSaving, error };
}

function EditorBody({
  header,
  before,
  text,
  onEdit,
  onCancel,
  save,
  isSaving,
  error,
}: {
  header: ReactNode;
  before: string;
  text: string;
  onEdit: (text: string) => void;
  onCancel: () => void;
  save: (text: string) => Promise<void>;
  isSaving: boolean;
  error: string;
}) {
  const [fieldError, setFieldError] = useState("");
  // Save writes exactly what was reviewed.
  const [reviewed, setReviewed] = useState<string | null>(null);

  const review = () => {
    if (text === before) return setFieldError(t("app.editor.noChanges"));
    try {
      JSON.parse(text);
    } catch {
      return setFieldError(t("app.editor.invalidJson"));
    }
    setReviewed(text);
  };

  return (
    <Layout
      header={header}
      content={
        <LayoutContent>
          <VStack gap={4}>
            {error && <Banner status="error" title={error} />}
            {reviewed === null ? (
              <CodeEditor
                label={t("app.editor.text", { format: "JSON" })}
                isLabelHidden
                language="json"
                value={text}
                onChange={(value) => {
                  onEdit(value);
                  setFieldError("");
                }}
                status={fieldError ? { type: "error", message: fieldError } : undefined}
              />
            ) : (
              <ReviewPane diff={diffText(before, reviewed)} />
            )}
          </VStack>
        </LayoutContent>
      }
      footer={
        <EditorFooter
          isReviewing={reviewed !== null}
          isSaving={isSaving}
          onCancel={onCancel}
          onReview={review}
          onBack={() => setReviewed(null)}
          onSave={() => reviewed !== null && void save(reviewed)}
        />
      }
    />
  );
}

function EditorFooter({
  isReviewing,
  isSaving,
  onCancel,
  onReview,
  onBack,
  onSave,
}: {
  isReviewing: boolean;
  isSaving: boolean;
  onCancel: () => void;
  onReview: () => void;
  onBack: () => void;
  onSave: () => void;
}) {
  return (
    <LayoutFooter>
      <HStack gap={2} hAlign="end">
        {isReviewing ? (
          <>
            <Button
              label={t("app.unsaved.keep")}
              variant="secondary"
              isDisabled={isSaving}
              onClick={onBack}
            />
            <Button
              label={t("app.editor.save")}
              variant="primary"
              icon={<Icon icon={icons.save} />}
              isLoading={isSaving}
              onClick={onSave}
            />
          </>
        ) : (
          <>
            <Button label={t("app.dialog.cancel")} variant="secondary" onClick={onCancel} />
            <Button label={t("app.editor.review")} variant="primary" onClick={onReview} />
          </>
        )}
      </HStack>
    </LayoutFooter>
  );
}

function ReviewPane({ diff }: { diff: string }) {
  return (
    <CodeColors>
      <CodeBlock code={diff} language="json" isDiff hasCopyButton={false} width="100%" />
    </CodeColors>
  );
}
