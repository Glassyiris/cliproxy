// The open account in the detail panel (a bottom sheet on phones), in the order an operator asks:
// is it serving and when does it come back, what the upstream said, the quota windows, what can
// be done, then its settings, models and file.
import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
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
import { useUnsavedChanges } from "../../app/useHashRoute.ts";
import { Identifier } from "../../components/Identifier.tsx";
import { useAvailable } from "../../components/MissingActions.tsx";
import { QuotaWindow, quotaErrorText } from "../../components/QuotaWindow.tsx";
import { ReadError } from "../../components/ReadError.tsx";
import { lampStatus, StatusLamp } from "../../components/StatusLamp.tsx";
import { Words } from "../../components/Words.tsx";
import { setCredentialFields } from "../../lib/api/credentials.ts";
import { routes } from "../../lib/api/routes.ts";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { layout } from "../../themes/site/layout.ts";
import { roles } from "../../themes/site/roles.ts";
import { PanelActions, type PanelProps } from "./PanelActions.tsx";
import { useCredentialModels } from "./queries.ts";
import { fieldPatch, fieldsOf, type FieldValues } from "./rows.ts";
import { ageOf, cooldownOf, lastOf, reasonOf, recoveryOf, statusOf } from "./words.ts";

/** A block of the panel: an h3 over its content. */
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <VStack gap={2}>
      <Heading level={3}>{title}</Heading>
      {children}
    </VStack>
  );
}

function State({ row, now }: Pick<PanelProps, "row"> & { now: number }) {
  const r = recoveryOf(row.view, now);
  const reason = row.view.ready ? "" : reasonOf(row.view, row.account);
  return (
    <MetadataList>
      <MetadataListItem label={t("accounts.columns.status")}>
        <StatusLamp status={lampStatus[row.view.lamp]} label={statusOf(row.view)} />
      </MetadataListItem>
      {reason && <MetadataListItem label={t("accounts.panel.reason")}>{reason}</MetadataListItem>}
      {!row.view.ready && (
        <MetadataListItem label={t("accounts.columns.recovery")}>
          <Words>
            {r.second ? t("accounts.panel.recoveryAt", { when: r.first, at: r.second }) : r.first}
          </Words>
        </MetadataListItem>
      )}
      <MetadataListItem label={t("accounts.panel.lastUsed")}>{lastOf(row.view)}</MetadataListItem>
      <MetadataListItem label={t("accounts.panel.quotaRead")}>
        {ageOf(row.view, now)}
      </MetadataListItem>
    </MetadataList>
  );
}

/**
 * What the upstream answered, as the server kept it: its message, and each cooldown with the HTTP
 * status that started it (REQUIREMENTS exception: operators see upstream error detail).
 */
function Upstream({ row, now }: Pick<PanelProps, "row"> & { now: number }) {
  const a = row.account;
  const cooldowns = a.cooldowns ?? [];
  if (!a.status_message && !cooldowns.length) return null;
  return (
    <Block title={t("accounts.panel.upstream")}>
      {a.status_message && (
        <Text type={roles.textType.identifier} textWrap="wrap">
          {a.status_message}
        </Text>
      )}
      {cooldowns.length > 0 && (
        <List density="compact" hasDividers>
          {cooldowns.map((c, i) => (
            <ListItem
              key={i}
              label={
                c.model_key ? (
                  <Identifier breakAt="name">{c.model_key}</Identifier>
                ) : (
                  t("accounts.cooldown.wholeAccount")
                )
              }
              description={cooldownOf(c, now)}
            />
          ))}
        </List>
      )}
    </Block>
  );
}

function Limits({ row, quota, now }: Pick<PanelProps, "row" | "quota"> & { now: number }) {
  const a = row.account;
  const limits = quota.limits(a);
  const windows = limits && "windows" in limits ? limits.windows : [];
  const staleFor = row.view.stale && limits && "at" in limits ? now - limits.at : null;
  const signals = Object.entries(a.quota?.signals ?? {});
  if (!windows.length && !limits?.error && !signals.length) return null;
  return (
    <Block title={t("accounts.panel.quota")}>
      <VStack gap={3}>
        {windows.map((w, i) => (
          <QuotaWindow key={i} bar={{ window: w, staleFor }} now={now} />
        ))}
        {limits?.error && (
          <StatusLamp
            status="failing"
            label={t("accounts.panel.usageFailed", { error: quotaErrorText(limits.error) })}
          />
        )}
        {/* The raw headers the windows were read from: rarely needed, so they start collapsed. */}
        {signals.length > 0 && (
          <Collapsible
            trigger={
              <Text type={roles.textType.body}>
                {t("accounts.panel.signals", { count: signals.length })}
              </Text>
            }
            defaultIsOpen={false}
          >
            <List density="compact" hasDividers>
              {signals.map(([k, v]) => (
                <ListItem
                  key={k}
                  label={
                    <Text type={roles.textType.identifier} textWrap="wrap" wordBreak="break-word">
                      {k}
                    </Text>
                  }
                  description={v}
                />
              ))}
            </List>
          </Collapsible>
        )}
      </VStack>
    </Block>
  );
}

function FieldsForm({ row, writes }: Pick<PanelProps, "row" | "writes">) {
  const isAvailable = useAvailable();
  const [saved, setSaved] = useState(() => fieldsOf(row.account));
  const [values, setValues] = useState(saved);
  const dirty = Object.keys(fieldPatch(saved, values)).length > 0;
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
    const patch = fieldPatch(saved, values);
    if (!Object.keys(patch).length) return;
    const ok = await writes.run(
      "fields",
      async () => {
        await setCredentialFields(row.id, patch);
        await writes.reload();
      },
      t("accounts.done.saved"),
    );
    if (ok) setSaved(values);
  };
  return (
    <Block title={t("accounts.panel.settings")}>
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
        {/* Buttons end on the right, at the panel's one button size. */}
        <HStack gap={2} hAlign="end">
          <Button
            label={t("accounts.fields.save")}
            size="sm"
            isLoading={writes.isBusy("fields")}
            isDisabled={!isAvailable(routes.setCredentialFields)}
            onClick={() => void save()}
          />
        </HStack>
      </VStack>
    </Block>
  );
}

function Models({ row }: Pick<PanelProps, "row">) {
  const models = useCredentialModels(row.id);
  return (
    <Block title={t("accounts.panel.models")}>
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
            <ListItem
              key={m.id}
              label={<Identifier breakAt="name">{m.id}</Identifier>}
              description={m.display_name}
            />
          ))}
        </List>
      ) : (
        <Text type={roles.textType.supporting} color="secondary">
          {t("accounts.panel.noModels")}
        </Text>
      )}
    </Block>
  );
}

function File({ row }: Pick<PanelProps, "row">) {
  const a = row.account;
  const refreshed = Date.parse(a.last_refresh ?? "");
  return (
    <Block title={t("accounts.panel.file")}>
      <MetadataList>
        <MetadataListItem label={t("accounts.panel.fileName")}>
          <Identifier breakAt="name">{a.name}</Identifier>
        </MetadataListItem>
        <MetadataListItem label={t("accounts.panel.authIndex")}>
          {a.auth_index ? <Identifier>{a.auth_index}</Identifier> : t("accounts.panel.none")}
        </MetadataListItem>
        <MetadataListItem label={t("accounts.panel.source")}>
          {a.source === "memory"
            ? t("accounts.panel.sourceMemory")
            : t("accounts.panel.sourceFile")}
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
      </MetadataList>
    </Block>
  );
}

export function AccountPanel(props: PanelProps & { now: number; onClose: () => void }) {
  const { row, quota, writes, now, onClose } = props;
  return (
    <VStack gap={roles.gap.card}>
      <HStack gap={2} vAlign="start">
        <StackItem size="fill">
          <VStack gap={0.5}>
            <Heading level={roles.heading.section} maxLines={1}>
              {row.name}
            </Heading>
            <Text type={roles.textType.supporting} color="secondary">
              {label(row.provider)}
            </Text>
          </VStack>
        </StackItem>
        <IconButton
          label={t("accounts.panel.close")}
          variant={roles.rowAction.variant}
          size={roles.rowAction.size}
          icon={<Icon icon={X} size="sm" />}
          onClick={onClose}
        />
      </HStack>
      <State row={row} now={now} />
      <PanelActions {...props} />
      <Divider />
      <Upstream row={row} now={now} />
      <Limits row={row} quota={quota} now={now} />
      {/* A runtime-only account takes the same fields, kept in memory (Rust auth_files.rs). */}
      <FieldsForm row={row} writes={writes} />
      <Models row={row} />
      <File row={row} />
    </VStack>
  );
}
