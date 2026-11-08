// The one editor for a config value as JSON or the whole file as YAML: a fullscreen form dialog
// (a plugin's settings) or inline (Settings, Advanced). Review shows the change as a diff and Save
// rereads the server copy first, refusing when it changed since the editor opened (REQUIREMENTS
// intentional design).
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog } from "@astryxdesign/core/Dialog";
import { HStack, VStack } from "@astryxdesign/core/Layout";
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
import { CodeColors, CodeEditor } from "./CodeEditor.tsx";
import { FormDialogHeader } from "./FormDialog.tsx";
import { ReadError } from "./ReadError.tsx";

/** A config key path such as "routing/strategy" (edited as JSON), or the whole file as YAML. */
export type ConfigSource = { path: string } | { yaml: true };

const sourceName = (source: ConfigSource) => ("path" in source ? source.path : "config.yaml");
const format = (source: ConfigSource) => ("path" in source ? "JSON" : "YAML");

const readSource = (source: ConfigSource, signal: AbortSignal): Promise<unknown> =>
  "path" in source
    ? readConfigValue(source.path, { signal, fallback: {} })
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
  action,
  onClose,
}: {
  source: ConfigSource | null;
  title: string;
  action: Action;
  onClose: () => void;
}) {
  if (!source) return null;
  return (
    <Editor
      key={sourceName(source)}
      source={source}
      title={title}
      action={action}
      onClose={onClose}
    />
  );
}

/** The copy the editor opened, the draft over it, and saving it. */
function useEditor(source: ConfigSource, action: Action, onSaved?: () => void) {
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
  useUnsavedChanges(isDirty);
  const saving = useSave(source, read.data, action, {
    // The saved text is the new server copy, and the next edit starts from it.
    onSaved: () => {
      setDraft(null);
      void read.refetch();
      onSaved?.();
    },
    // The draft stays, so Review shows it against the new server copy.
    onRefused: () => void read.refetch(),
  });
  return { read, before, text, isDirty, setDraft, ...saving };
}

type EditorState = ReturnType<typeof useEditor>;

function EditorContent({
  source,
  title,
  editor,
}: {
  source: ConfigSource;
  title: string;
  editor: EditorState;
}) {
  const { read } = editor;
  if (read.isPending)
    return (
      <Center axis="both" padding={10}>
        <Spinner aria-label={t("app.read.loading", { what: title })} />
      </Center>
    );
  if (read.isError)
    return <ReadError error={read.error} what={title} retry={() => void read.refetch()} />;
  // Keyed on the server copy, so a save or a refusal returns to the text from review.
  return (
    <EditorBody
      key={editor.before}
      source={source}
      before={editor.before}
      text={editor.text}
      onEdit={editor.setDraft}
      save={editor.save}
      isSaving={editor.isSaving}
      error={editor.error}
    />
  );
}

function Editor({
  source,
  title,
  action,
  onClose,
}: {
  source: ConfigSource;
  title: string;
  action: Action;
  onClose: () => void;
}) {
  const editor = useEditor(source, action, onClose);
  const [isAsking, setAsking] = useState(false);
  // A save cannot be called back once sent, so the editor stays open until it ends.
  const close = () => !editor.isSaving && (editor.isDirty ? setAsking(true) : onClose());

  return (
    <Dialog isOpen onOpenChange={(open) => !open && close()} variant="fullscreen" purpose="form">
      <FormDialogHeader
        title={title}
        subtitle={<Text type="code">{sourceName(source)}</Text>}
        busy={editor.isSaving}
        busyLabel={t("app.editor.closeWhileSaving")}
        onClose={close}
      />
      <EditorContent source={source} title={title} editor={editor} />
      <AlertDialog
        isOpen={isAsking}
        onOpenChange={setAsking}
        title={t("app.unsaved.title")}
        description={t("app.editor.discardDescription")}
        actionLabel={t("app.unsaved.discard")}
        cancelLabel={t("app.unsaved.keep")}
        onAction={onClose}
      />
    </Dialog>
  );
}

/** The editor in the page itself; after a save it goes on from the saved copy. */
export function InlineConfigEditor({
  source,
  title,
  action,
}: {
  source: ConfigSource;
  title: string;
  action: Action;
}) {
  const editor = useEditor(source, action);
  return <EditorContent source={source} title={title} editor={editor} />;
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
  before,
  text,
  onEdit,
  save,
  isSaving,
  error,
}: {
  source: ConfigSource;
  before: string;
  text: string;
  onEdit: (text: string) => void;
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
    <VStack gap={4}>
      {error && <Banner status="error" title={error} />}
      {reviewed === null ? (
        <>
          <CodeEditor
            label={t("app.editor.text", { format: format(source) })}
            language={"path" in source ? "json" : "yaml"}
            value={text}
            onChange={(value) => {
              onEdit(value);
              setFieldError("");
            }}
            status={fieldError ? { type: "error", message: fieldError } : undefined}
          />
          <HStack gap={2}>
            <Button label={t("app.editor.review")} variant="primary" onClick={review} />
          </HStack>
        </>
      ) : (
        <ReviewPane
          source={source}
          diff={diffText(before, reviewed)}
          isSaving={isSaving}
          onSave={() => void save(reviewed)}
          onBack={() => setReviewed(null)}
        />
      )}
    </VStack>
  );
}

function ReviewPane({
  source,
  diff,
  isSaving,
  onSave,
  onBack,
}: {
  source: ConfigSource;
  diff: string;
  isSaving: boolean;
  onSave: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <CodeColors>
        <CodeBlock
          code={diff}
          language={format(source).toLowerCase()}
          isDiff
          hasCopyButton={false}
          width="100%"
        />
      </CodeColors>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Button
          label={t("app.editor.save")}
          variant="primary"
          isLoading={isSaving}
          onClick={onSave}
        />
        <Button label={t("app.unsaved.keep")} variant="secondary" onClick={onBack} />
        {"yaml" in source && (
          <Text type="supporting" color="secondary">
            {t("app.editor.yamlNote")}
          </Text>
        )}
      </HStack>
    </>
  );
}
