// The open key group in the detail panel (a bottom sheet on phones): whether it serves, where it
// sends requests, each key with its traffic, its models, and the writes the row menu also holds.
import { useState, type ReactNode } from "react";
import { Eye, X } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { RequestSparkline } from "../../components/RequestSparkline.tsx";
import { StatusLamp } from "../../components/StatusLamp.tsx";
import { mask } from "../../lib/client-keys.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { roles } from "../../themes/site/roles.ts";
import { familyName } from "../../components/keyFamilies.ts";
import { isFailing, modelText, type Entry, type Model } from "./groups.ts";
import type { GroupAction } from "./useGroupWrites.ts";
import { statusOf } from "./words.ts";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <VStack gap={2}>
      <Heading level={3}>{title}</Heading>
      {children}
    </VStack>
  );
}

/** A key masked, with its own reveal and copy at the row's end, as Clients draws a key. */
function KeyActions({
  value,
  revealed,
  onReveal,
}: {
  value: string;
  revealed: boolean;
  onReveal: () => void;
}) {
  const { copy, isCopied } = useClipboard();
  const reveal = revealed ? t("providers.key.hide") : t("providers.key.show");
  return (
    <HStack gap={1} vAlign="center">
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

function Keys({ entry }: { entry: Entry }) {
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (i: number) =>
    setRevealed((now) => {
      const next = new Set(now);
      if (!next.delete(i)) next.add(i);
      return next;
    });
  return (
    <Block title={t("providers.panel.keys")}>
      {entry.keys.length ? (
        <List density="compact" hasDividers>
          {entry.keys.map(({ key, traffic }, i) => {
            const value = String(key["api-key"] ?? "");
            const shown = revealed.has(i);
            return (
              <ListItem
                key={i}
                label={
                  <Text type={roles.textType.identifier} textWrap={shown ? "wrap" : "nowrap"}>
                    {shown ? value : mask(value)}
                  </Text>
                }
                endContent={
                  <KeyActions value={value} revealed={shown} onReveal={() => toggle(i)} />
                }
                description={
                  <VStack gap={1}>
                    <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
                      {t("providers.panel.weight", { weight: key.weight ?? 1 })}
                    </Text>
                    {isFailing(traffic) && (
                      <StatusLamp status="failing" label={t("providers.status.keyFailing")} />
                    )}
                    {traffic ? (
                      <RequestSparkline buckets={traffic} times={traffic.times} />
                    ) : (
                      <Text type={roles.textType.supporting} color="secondary">
                        {t("app.quota.notReported")}
                      </Text>
                    )}
                  </VStack>
                }
              />
            );
          })}
        </List>
      ) : (
        <Text type={roles.textType.supporting} color="secondary">
          {t("providers.table.noKeys")}
        </Text>
      )}
    </Block>
  );
}

/** The group's model names as plain identifiers, or that it serves every model. */
function Models({ models }: { models: Model[] }) {
  if (!models.length) return t("providers.table.allModels");
  return (
    <HStack gap={3} wrap="wrap">
      {models.map((m, i) => (
        <Text key={i} type={roles.textType.identifier}>
          {modelText(m)}
        </Text>
      ))}
    </HStack>
  );
}

export function GroupPanel({
  entry,
  busy,
  onAction,
  onClose,
}: {
  entry: Entry;
  busy: boolean;
  onAction: (action: GroupAction) => void;
  onClose: () => void;
}) {
  const { family, index, group } = entry;
  const s = statusOf(entry);
  const models = group.models?.filter((m) => m.name) ?? [];
  return (
    <VStack gap={roles.gap.card}>
      <HStack gap={2} vAlign="start">
        <StackItem size="fill">
          <VStack gap={0.5}>
            <Heading level={roles.heading.section} maxLines={1}>
              {entry.name}
            </Heading>
            <Text type={roles.textType.supporting} color="secondary">
              {familyName(family)}
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
          {group["base-url"] ? (
            <Text type={roles.textType.identifier}>{group["base-url"]}</Text>
          ) : (
            t("providers.group.defaultEndpoint")
          )}
        </MetadataListItem>
        <MetadataListItem label={t("providers.panel.models")}>
          <Models models={models} />
        </MetadataListItem>
      </MetadataList>
      <HStack gap={2} wrap="wrap">
        {family === "openai-compatibility" && (
          <Button
            label={group.disabled ? t("providers.group.enable") : t("providers.group.disable")}
            size={roles.rowAction.size}
            isDisabled={busy}
            onClick={() => onAction({ kind: "toggle", family, index })}
          />
        )}
        <Button
          label={t("providers.group.deleteOne")}
          variant="destructive"
          size={roles.rowAction.size}
          isDisabled={busy}
          onClick={() => onAction({ kind: "delete", family, index })}
        />
      </HStack>
      <Keys entry={entry} />
    </VStack>
  );
}
