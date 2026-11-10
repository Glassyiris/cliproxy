import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { HStack, Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import type { Action } from "../app/useAction.ts";
import { JsonEditorDialog, useJsonEditor } from "./ConfigEditor.tsx";
import {
  ConfigChangedError,
  readConfigValue,
  replaceConfigValue,
  type ConfigResource,
} from "../lib/api/config.ts";
import { replacePluginConfig, revealPluginConfig } from "../lib/api/plugins.ts";
import { t } from "../lib/i18n.ts";

type Props = {
  id: string | null;
  title: string;
  hashKey: string;
  action: Action;
  onClose: () => void;
};
const absent = {};

/** Plaintext and its revision remain local to this explicit reveal/edit session. */
export function PluginConfigEditor(props: Props) {
  return props.id ? (
    <PluginEditor key={props.id} {...props} id={props.id} path={`plugins/configs/${props.id}`} />
  ) : null;
}

function PluginEditor({
  id,
  path,
  title,
  hashKey,
  action,
  onClose,
}: Props & { id: string; path: string }) {
  const [revealed, setRevealed] = useState<ConfigResource | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  const read = useQuery({
    queryKey: ["config-editor", path],
    queryFn: ({ signal }) => readConfigValue(path, { signal, fallback: absent }),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const editor = useJsonEditor(
    path,
    read,
    revealed ? revealed.spec : read.data,
    action,
    hashKey,
    onClose,
    (spec) => {
      if (read.data !== absent || spec === "$secret") {
        if (!revealed || spec === "$secret") throw new ConfigChangedError(path);
        return replacePluginConfig(revealed, spec);
      }
      return replaceConfigValue(path, absent, spec, absent);
    },
    () => setRevealed(null),
  );
  const reveal = () =>
    action.run(async () => {
      const resource = await revealPluginConfig(id);
      if (mounted.current) setRevealed(resource);
    });
  return (
    <JsonEditorDialog
      path={path}
      title={title}
      onClose={onClose}
      editor={{
        ...editor,
        isAbsent: read.data === absent,
        prompt:
          read.data === "$secret" && !revealed
            ? (header, onCancel) => (
                <RevealPrompt
                  header={header}
                  onCancel={onCancel}
                  busy={action.busy}
                  reveal={reveal}
                />
              )
            : undefined,
      }}
    />
  );
}

function RevealPrompt({
  header,
  onCancel,
  busy,
  reveal,
}: {
  header: ReactNode;
  onCancel: () => void;
  busy: boolean;
  reveal: () => Promise<unknown>;
}) {
  return (
    <Layout
      header={header}
      content={
        <LayoutContent>
          <Button
            label={t("keys.row.show")}
            variant="secondary"
            isLoading={busy}
            onClick={() => void reveal()}
          />
        </LayoutContent>
      }
      footer={
        <LayoutFooter>
          <HStack hAlign="end">
            <Button label={t("app.dialog.cancel")} variant="secondary" onClick={onCancel} />
          </HStack>
        </LayoutFooter>
      }
    />
  );
}
