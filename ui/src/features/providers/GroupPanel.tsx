// The open key group in the detail panel (a bottom sheet on phones), in the account panel's
// anatomy: the title with its family, the facts, one row of actions at the end, then the sections
// (each key with its weight, traffic, reveal and copy; the models, when the group restricts them).
import { PanelBlock } from "../../components/PanelBlock.tsx";
import { useState } from "react";
import { Eye, Trash2, X } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Identifier } from "../../components/Identifier.tsx";
import { familyName } from "../../components/keyFamilies.ts";
import { RequestSparkline } from "../../components/RequestSparkline.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { mask } from "../../lib/clientKeys.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { roles } from "../../themes/site/roles.ts";
import { isFailing, modelText, type Entry, type Key, type KeyTraffic } from "./groups.ts";
import { MiddleText } from "./MiddleText.tsx";
import type { GroupAction } from "./useGroupWrites.ts";
import { statusOf } from "./words.ts";

// The characters a revealed key keeps at its end when the line is too short for all of it.
const KEY_TAIL = 4;

function KeyText({ value, revealed }: { value: string; revealed: boolean }) {
  if (!revealed)
    return (
      <Text type={roles.textType.body} textWrap="nowrap" hasTabularNumbers>
        {mask(value)}
      </Text>
    );
  return <MiddleText head={value.slice(0, -KEY_TAIL)} tail={value.slice(-KEY_TAIL)} />;
}

function KeyEnd({
  value,
  traffic,
  revealed,
  onReveal,
}: {
  value: string;
  traffic: KeyTraffic | null;
  revealed: boolean;
  onReveal: () => void;
}) {
  const { copy, isCopied } = useClipboard();
  const reveal = revealed ? t("providers.key.hide") : t("providers.key.show");
  return (
    <HStack gap={1} vAlign="center" wrap="nowrap">
      {traffic ? (
        <RequestSparkline buckets={traffic} times={traffic.times} />
      ) : (
        <Text type={roles.textType.supporting} color="secondary">
          {t("app.quota.notReported")}
        </Text>
      )}
      <IconButton
        label={reveal}
        tooltip={reveal}
        size={roles.rowAction.size}
        variant={roles.rowAction.variant}
        icon={<Icon icon={revealed ? "eyeSlash" : Eye} size="sm" />}
        aria-pressed={revealed}
        onClick={onReveal}
      />
      <IconButton
        label={t("providers.key.copy")}
        tooltip={t("providers.key.copy")}
        size={roles.rowAction.size}
        variant={roles.rowAction.variant}
        icon={<Icon icon={isCopied ? "check" : "copy"} size="sm" />}
        onClick={() =>
          void copy(value).then((ok) =>
            ok
              ? notify("success", t("providers.key.copied"))
              : notify("error", t("providers.key.copyFailed")),
          )
        }
      />
    </HStack>
  );
}

function KeyRow({
  keyEntry: { key, traffic },
  revealed,
  onReveal,
}: {
  keyEntry: { key: Key; traffic: KeyTraffic | null };
  revealed: boolean;
  onReveal: () => void;
}) {
  const value = String(key["api-key"] ?? "");
  return (
    <ListItem
      label={<KeyText value={value} revealed={revealed} />}
      description={
        <VStack gap={0.5}>
          <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
            {t("providers.panel.weight", { weight: key.weight ?? 1 })}
          </Text>
          {isFailing(traffic) && (
            <StatusLamp status="failing" label={t("providers.status.keyFailing")} />
          )}
        </VStack>
      }
      endContent={
        <KeyEnd value={value} traffic={traffic} revealed={revealed} onReveal={onReveal} />
      }
    />
  );
}

function Keys({ entry }: { entry: Entry }) {
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (i: number) =>
    setRevealed((now) => {
      const next = new Set(now);
      if (!next.delete(i)) next.add(i);
      return next;
    });
  return (
    <PanelBlock title={t("providers.panel.keys")}>
      {entry.keys.length ? (
        <List density="compact" hasDividers>
          {entry.keys.map((k, i) => (
            <KeyRow key={i} keyEntry={k} revealed={revealed.has(i)} onReveal={() => toggle(i)} />
          ))}
        </List>
      ) : (
        <Text type={roles.textType.supporting} color="secondary">
          {t("providers.table.noKeys")}
        </Text>
      )}
    </PanelBlock>
  );
}

/** The models a group is restricted to; a group serving every model has no section. */
function Models({ entry }: { entry: Entry }) {
  const models = entry.group.models?.filter((m) => m.name) ?? [];
  if (!models.length) return null;
  return (
    <PanelBlock title={t("providers.panel.models")}>
      <List density="compact" hasDividers>
        {models.map((m, i) => (
          <ListItem key={i} label={<Identifier breakAt="name">{modelText(m)}</Identifier>} />
        ))}
      </List>
    </PanelBlock>
  );
}

function Actions({
  entry,
  busy,
  toggling,
  onAction,
}: {
  entry: Entry;
  busy: boolean;
  toggling: boolean;
  onAction: (action: GroupAction) => void;
}) {
  const { family, index, group } = entry;
  return (
    <HStack gap={2} vAlign="center" hAlign="end">
      {family === "openai-compatibility" && (
        <Button
          label={group.disabled ? t("providers.group.enable") : t("providers.group.disable")}
          size="sm"
          isLoading={toggling}
          isDisabled={busy}
          onClick={() => onAction({ kind: "toggle", family, index })}
        />
      )}
      <MoreMenu
        label={t("app.list.moreActions")}
        variant="secondary"
        size="sm"
        alignment="end"
        items={[
          {
            label: t("providers.group.deleteOne"),
            icon: Trash2,
            variant: "destructive",
            isDisabled: busy,
            onClick: () => onAction({ kind: "delete", family, index }),
          },
        ]}
      />
    </HStack>
  );
}

export function GroupPanel({
  entry,
  busy,
  toggling,
  onAction,
  onClose,
}: {
  entry: Entry;
  busy: boolean;
  toggling: boolean;
  onAction: (action: GroupAction) => void;
  onClose: () => void;
}) {
  const s = statusOf(entry);
  const url = entry.group["base-url"];
  return (
    <VStack gap={roles.gap.card}>
      <HStack gap={2} vAlign="start">
        <StackItem size="fill">
          <VStack gap={0.5}>
            <Heading level={roles.heading.section} maxLines={1}>
              {entry.name}
            </Heading>
            <Text type={roles.textType.supporting} color="secondary">
              {familyName(entry.family)}
            </Text>
          </VStack>
        </StackItem>
        <IconButton
          label={t("providers.panel.close")}
          variant={roles.rowAction.variant}
          size={roles.rowAction.size}
          icon={<Icon icon={X} size="sm" />}
          onClick={onClose}
        />
      </HStack>
      <MetadataList>
        <MetadataListItem label={t("providers.table.status")}>
          <StatusLamp status={s.status} label={s.label} />
        </MetadataListItem>
        <MetadataListItem label={t("providers.panel.endpoint")}>
          {url ? <Identifier>{url}</Identifier> : t("providers.group.defaultEndpoint")}
        </MetadataListItem>
      </MetadataList>
      <Actions entry={entry} busy={busy} toggling={toggling} onAction={onAction} />
      <Divider />
      <Keys entry={entry} />
      <Models entry={entry} />
    </VStack>
  );
}
