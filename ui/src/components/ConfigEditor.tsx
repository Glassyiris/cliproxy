// The one editor for a config value as JSON or the whole file as YAML, in a form dialog (a
// plugin's settings; a section or the file under Settings, Advanced). Review shows the change as a
// diff and Save rereads the server copy first, refusing when it changed since the editor opened
// (REQUIREMENTS intentional design).
// Template: the DialogFormDialog block: Dialog `purpose="form"`, a Layout with the DialogHeader,
// the content, and Cancel beside the primary action at the end of a LayoutFooter; only the content
// scrolls. Deviation: the preferences dialog's size (layout.settingsDialog), not the block's 480,
// for every editor, since code lines are long (owner, 2026-11-08: 「編輯器默認大小和設置的差不多把？」).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog } from "@astryxdesign/core/Dialog";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { serverKeys } from "../app/serverQueries.ts";
import { failureNotice, type Action } from "../app/useAction.ts";
import { useUnsavedChanges } from "../app/useHashRoute.ts";
import {
  ConfigChangedError,
  readConfigValue,
  readConfigYaml,
  replaceConfigValue,
  writeConfigYaml,
} from "../lib/api/config.ts";
import { lineDiff } from "../lib/compare.ts";
import { t } from "../lib/i18n.ts";
import { notify } from "../lib/notify.ts";
import { layout } from "../themes/site/layout.ts";
import { CodeColors, CodeEditor } from "./CodeEditor.tsx";
import { FormDialogHeader } from "./FormDialog.tsx";
import { ReadError } from "./ReadError.tsx";

/** A config key path such as "routing/strategy" (edited as JSON), or the whole file as YAML. */
export type ConfigSource = { path: string } | { yaml: true };

const sourceName = (source: ConfigSource) => ("path" in source ? source.path : "config.yaml");
const format = (source: ConfigSource) => ("path" in source ? "JSON" : "YAML");

/** What the editor opens for a key the file lacks: an empty object, told apart by identity. */
const absent = {};

const readSource = (source: ConfigSource, signal: AbortSignal): Promise<unknown> =>
  "path" in source
    ? readConfigValue(source.path, { signal, fallback: absent })
    : readConfigYaml(signal);

const asText = (source: ConfigSource, value: unknown) =>
  "path" in source ? JSON.stringify(value, null, 2) : String(value);

/** Write `text` only while the server still holds `baseline`, the copy the editor opened. */
async function write(source: ConfigSource, baseline: unknown, text: string) {
  if ("path" in source) return replaceConfigValue(source.path, baseline, JSON.parse(text));
  if ((await readConfigYaml()) !== baseline) throw new ConfigChangedError("config.yaml");
  return writeConfigYaml(text);
}

const diffText = (before: string, after: string) =>
  lineDiff(before, after)
    .map((l) => `${l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " "}${l.text}`)
    .join("\n");

/** Plugins read their switches from config, so these writes also change the plugin list. */
const touchesPlugins = (source: ConfigSource) =>
  "yaml" in source || source.path === "plugins" || source.path.startsWith("plugins/");

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
      key={sourceName(source)}
      source={source}
      title={title}
      hashKey={hashKey}
      action={action}
      onClose={onClose}
    />
  );
}

/** The copy the editor opened, the draft over it, and saving it. */
function useEditor(source: ConfigSource, action: Action, hashKey: string, onSaved: () => void) {
  // Read when the editor opens, and again after a save or when one is refused: this copy is what
  // Save compares the server against.
  const read = useQuery({
    queryKey: ["config-editor", sourceName(source)],
    queryFn: ({ signal }) => readSource(source, signal),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const before = read.isSuccess ? asText(source, read.data) : "";
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? before;
  const isDirty = text !== before;
  const release = useUnsavedChanges(isDirty, hashKey);
  const saving = useSave(source, read.data, action, {
    // The saved text is the new server copy, and the next edit starts from it.
    onSaved: () => {
      setDraft(null);
      void read.refetch();
      release();
      onSaved();
    },
    // The draft stays, so Review shows it against the new server copy.
    onRefused: () => void read.refetch(),
  });
  const isAbsent = read.data === absent;
  return { read, before, text, isDirty, isAbsent, setDraft, release, ...saving };
}

type EditorState = ReturnType<typeof useEditor>;

function EditorContent({
  source,
  title,
  header,
  editor,
  onCancel,
}: {
  source: ConfigSource;
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
  // Keyed on the server copy, so a save or a refusal returns to the text from review.
  return (
    <EditorBody
      key={editor.before}
      source={source}
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
  const [isAsking, setAsking] = useState(false);
  // A save cannot be called back once sent, so the editor stays open until it ends.
  const close = () => !editor.isSaving && (editor.isDirty ? setAsking(true) : onClose());
  const discard = () => {
    editor.release();
    onClose();
  };
  // A plugin's title is its name, so the path follows; a section's title is its path already.
  const subtitle =
    title !== sourceName(source) ? (
      <Text type="code">{sourceName(source)}</Text>
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
        source={source}
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
  baseline: unknown,
  action: Action,
  then: { onSaved: () => void; onRefused: () => void },
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
        await write(source, baseline, next);
        saved = true;
      } catch (e) {
        if (!mounted.current) return;
        if (e instanceof ConfigChangedError) {
          then.onRefused();
          throw e;
        }
        setError(failureNotice(e)?.message ?? "");
      } finally {
        if (mounted.current) setSaving(false);
        await queryClient.invalidateQueries({ queryKey: serverKeys.config });
        if (saved && touchesPlugins(source))
          await queryClient.invalidateQueries({ queryKey: serverKeys.plugins });
      }
    });
    if (!saved || !mounted.current) return;
    notify("success", t("app.editor.saved"));
    then.onSaved();
  };
  return { save, isSaving, error };
}

function EditorBody({
  source,
  header,
  before,
  text,
  onEdit,
  onCancel,
  save,
  isSaving,
  error,
}: {
  source: ConfigSource;
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
    if ("path" in source)
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
                label={t("app.editor.text", { format: format(source) })}
                isLabelHidden
                language={"path" in source ? "json" : "yaml"}
                value={text}
                onChange={(value) => {
                  onEdit(value);
                  setFieldError("");
                }}
                status={fieldError ? { type: "error", message: fieldError } : undefined}
              />
            ) : (
              <ReviewPane source={source} diff={diffText(before, reviewed)} />
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

/** Cancel and Review while editing, Keep editing and Save in review; the primary one last. */
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
            <Button label={t("app.unsaved.keep")} variant="secondary" onClick={onBack} />
            <Button
              label={t("app.editor.save")}
              variant="primary"
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

function ReviewPane({ source, diff }: { source: ConfigSource; diff: string }) {
  return (
    <CodeColors>
      <CodeBlock
        code={diff}
        language={format(source).toLowerCase()}
        isDiff
        hasCopyButton={false}
        width="100%"
      />
    </CodeColors>
  );
}
