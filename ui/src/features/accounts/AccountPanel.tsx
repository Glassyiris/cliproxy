// The open account in the template's end panel (a bottom sheet on phones): its facts, quota,
// cooldowns, fields and models, then what can be done to it.
import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { useUnsavedChanges } from "../../app/useHashRoute.ts";
import { useAvailable } from "../../components/MissingActions.tsx";
import { QuotaWindow } from "../../components/QuotaWindow.tsx";
import { lampStatus, StatusLamp } from "../../components/StatusLamp.tsx";
import { setCredentialFields } from "../../lib/api/credentials.ts";
import { routes } from "../../lib/api/routes.ts";
import { equal } from "../../lib/compare.ts";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { PanelActions, type PanelProps } from "./PanelActions.tsx";
import { useCredentialModels } from "./queries.ts";
import { fieldPatch, fieldsOf, type FieldValues } from "./rows.ts";
import { cooldownOf, subOf, wordOf } from "./words.ts";

function Facts({ row }: Pick<PanelProps, "row">) {
  const a = row.account;
  const refreshed = Date.parse(a.last_refresh ?? "");
  return (
    <MetadataList>
      <MetadataListItem label={t("accounts.panel.file")}>
        <Code>{a.name}</Code>
      </MetadataListItem>
      <MetadataListItem label={t("accounts.panel.authIndex")}>
        {a.auth_index ? <Code>{a.auth_index}</Code> : t("accounts.panel.none")}
      </MetadataListItem>
      <MetadataListItem label={t("accounts.panel.source")}>
        {a.source === "memory" ? t("accounts.panel.sourceMemory") : t("accounts.panel.sourceFile")}
      </MetadataListItem>
      <MetadataListItem label={t("accounts.panel.lifetime")}>
        {a.success === undefined
          ? t("app.quota.notReported")
          : t("accounts.panel.lifetimeCounts", { ok: a.success, failed: a.failed || 0 })}
      </MetadataListItem>
      {refreshed > 0 && (
        <MetadataListItem label={t("accounts.panel.refreshed")}>
          {t("accounts.panel.at", { at: refreshed })}
        </MetadataListItem>
      )}
      {a.status_message && (
        <MetadataListItem label={t("accounts.panel.statusMessage")}>
          {a.status_message}
        </MetadataListItem>
      )}
    </MetadataList>
  );
}

function Limits({ row, quota, now }: Pick<PanelProps, "row" | "quota"> & { now: number }) {
  const a = row.account;
  const limits = quota.limits(a);
  const windows = limits && "windows" in limits ? limits.windows : [];
  const staleFor = row.view.stale && limits && "at" in limits ? now - limits.at : null;
  const signals = Object.entries(a.quota?.signals ?? {});
  const cooldowns = a.cooldowns ?? [];
  return (
    <VStack gap={3}>
      {windows.map((w, i) => (
        <QuotaWindow key={i} bar={{ window: w, staleFor }} now={now} />
      ))}
      {limits?.error && (
        <StatusLamp
          status="failing"
          label={t("accounts.panel.usageFailed", { error: limits.error })}
        />
      )}
      {(cooldowns.length > 0 || signals.length > 0) && (
        <HStack gap={1} wrap="wrap">
          {cooldowns.map((c, i) => (
            <Token key={`c${i}`} size="sm" label={cooldownOf(c, now)} />
          ))}
          {signals.map(([k, v]) => (
            <Token key={k} size="sm" label={t("accounts.panel.signal", { name: k, value: v })} />
          ))}
        </HStack>
      )}
    </VStack>
  );
}

function FieldsForm({ row, writes }: Pick<PanelProps, "row" | "writes">) {
  const isAvailable = useAvailable();
  const [saved, setSaved] = useState(() => fieldsOf(row.account));
  const [values, setValues] = useState(saved);
  const dirty = !equal(values, saved);
  useUnsavedChanges(dirty);
  const set = (changes: Partial<FieldValues>) => setValues((v) => ({ ...v, ...changes }));
  const number = (k: "priority" | "weight" | "request_retry", text: string, hint: string) => (
    <NumberInput
      label={text}
      placeholder={hint}
      value={values[k]}
      isIntegerOnly
      hasClear
      onChange={(v: number | null) => set({ [k]: v })}
    />
  );
  const save = async () => {
    const ok = await writes.run(
      "fields",
      async () => {
        await setCredentialFields(row.id, fieldPatch(row.account, values));
        await writes.reload();
      },
      t("accounts.done.saved"),
    );
    if (ok) setSaved(values);
  };
  return (
    <VStack gap={3}>
      <TextInput
        label={t("accounts.fields.note")}
        value={values.note}
        onChange={(note) => set({ note })}
      />
      <HStack gap={2} wrap="wrap">
        {number("priority", t("accounts.fields.priority"), t("accounts.fields.priorityHint"))}
        {number("weight", t("accounts.fields.weight"), t("accounts.fields.weightHint"))}
        {number("request_retry", t("accounts.fields.retries"), t("accounts.fields.retriesHint"))}
      </HStack>
      <HStack gap={2}>
        <Button
          label={t("accounts.fields.save")}
          isLoading={writes.isBusy("fields")}
          isDisabled={!isAvailable(routes.setCredentialFields)}
          onClick={() => void save()}
        />
      </HStack>
    </VStack>
  );
}

function Models({ row }: Pick<PanelProps, "row">) {
  const models = useCredentialModels(row.id);
  return (
    <VStack gap={2}>
      <Heading level={3}>{t("accounts.panel.models")}</Heading>
      {models.isPending ? (
        <Skeleton width={layout.valueSkeleton.width} height={layout.valueSkeleton.height} />
      ) : models.isError ? (
        <ReadError
          error={models.error}
          what={t("accounts.panel.models")}
          retry={() => void models.refetch()}
        />
      ) : models.data.length ? (
        <List density="compact" hasDividers>
          {models.data.map((m) => (
            <ListItem key={m.id} label={<Code>{m.id}</Code>} description={m.display_name} />
          ))}
        </List>
      ) : (
        <Text type="supporting" color="secondary">
          {t("accounts.panel.noModels")}
        </Text>
      )}
    </VStack>
  );
}

export function AccountPanel(props: PanelProps & { now: number; onClose: () => void }) {
  const { row, quota, writes, now, onClose } = props;
  const sub = subOf(row.view);
  return (
    <VStack gap={4}>
      <HStack gap={2}>
        <StackItem size="fill">
          <VStack gap={1}>
            <StatusLamp status={lampStatus[row.view.lamp]} label={wordOf(row.view, now)} />
            <Heading level={2}>{row.name}</Heading>
            <Text type="supporting" color="secondary">
              {[label(row.provider), sub].filter(Boolean).join(" · ")}
            </Text>
          </VStack>
        </StackItem>
        <IconButton
          label={t("accounts.panel.close")}
          variant="ghost"
          size="sm"
          icon={<Icon icon={X} size="sm" />}
          onClick={onClose}
        />
      </HStack>
      <PanelActions {...props} />
      <Divider />
      <Facts row={row} />
      <Limits row={row} quota={quota} now={now} />
      {/* A runtime-only account takes the same fields, kept in memory (Rust auth_files.rs). */}
      <FieldsForm row={row} writes={writes} />
      <Models row={row} />
    </VStack>
  );
}
