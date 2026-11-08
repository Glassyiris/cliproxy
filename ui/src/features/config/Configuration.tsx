// Template: settings-sidebar. A list of setting groups beside the open group; below the phone
// breakpoint the list and the group are two views, the group with a back button.
// Deviations:
// - In PageFrame with its LayoutHeader and h1 (DESIGN.md "Roles", Header): the template has no
//   header, and its own nav heading ("Account settings") would stack under the h1, so it is gone.
// - Rows are label and hint beside the control on a two-column Grid, not the template's
//   expand-to-edit rows: every setting is a control that edits in place, and one Save in the header
//   reviews all changes as a diff first (brief R5), which per-row Save buttons cannot show.
// - The group is `?section=` in the hash, so Back and reload keep it; the template keeps it in state.
// - Icons are lucide, not heroicons; the "Professional hosting tools" list and the info cards are
//   gone: cliproxy has no counterpart.
import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileCode, KeyRound, Globe, Route, ScrollText, Send } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { PageFrame } from "../../app/PageFrame.tsx";
import { serverKeys, useConfig } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { useHashParams, useHashRoute, useUnsavedChanges } from "../../app/useHashRoute.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { SectionHeading } from "../../components/SectionHeading.tsx";
import { replaceConfigValue, type Config } from "../../lib/api/config.ts";
import { absent } from "../../lib/config-path.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { layout } from "../../themes/site/layout.ts";
import { Advanced } from "./Advanced.tsx";
import { Access } from "./Access.tsx";
import { ReviewDialog } from "./ReviewDialog.tsx";
import { Control, Row } from "./SettingRow.tsx";
import {
  changes,
  groups,
  settingId,
  settingsOf,
  shown,
  type Change,
  type Draft,
  type Group,
} from "./settings.ts";

const icons: Record<Group, IconProps["icon"]> = {
  routing: Route,
  access: KeyRound,
  network: Globe,
  requests: Send,
  logging: ScrollText,
  advanced: FileCode,
};

const isGroup = (value: string | undefined): value is Group =>
  (groups as readonly string[]).includes(value ?? "");

function GroupList({
  active,
  isNarrow,
  onSelect,
}: {
  active: Group | null;
  isNarrow: boolean;
  onSelect: (group: Group) => void;
}) {
  return (
    <VStack paddingBlock={4} paddingInline={3} id="settings-nav">
      <List density="spacious" aria-label={t("config.nav.label")}>
        {groups.map((group) => (
          <ListItem
            key={group}
            label={t(`config.group.${group}`)}
            startContent={<Icon icon={icons[group]} />}
            endContent={
              isNarrow ? <Icon icon="chevronRight" size="sm" color="secondary" /> : undefined
            }
            isSelected={!isNarrow && group === active}
            onClick={() => onSelect(group)}
          />
        ))}
      </List>
    </VStack>
  );
}

/** The rows of one group; `config` is undefined while it loads. */
function GroupRows({
  group,
  config,
  draft,
  onChange,
}: {
  group: Group;
  config: Config | undefined;
  draft: Draft;
  onChange: (path: string, value: unknown) => void;
}) {
  const rows = settingsOf(group).map((setting) => (
    <VStack key={setting.path} gap={0}>
      <Row
        label={t(`config.label.${settingId(setting)}`)}
        hint={t(`config.hint.${settingId(setting)}`)}
        note={setting.restart ? t("config.row.restart") : undefined}
      >
        <Control
          setting={setting}
          value={config && shown(config, setting, draft)}
          onChange={(value) => onChange(setting.path, value)}
        />
      </Row>
      <Divider />
    </VStack>
  ));
  return (
    <VStack gap={0}>
      {group === "access" && <Access config={config} />}
      {rows}
    </VStack>
  );
}

/** Write each change in turn, each compared with the file first; the first refusal stops. */
function useSaveChanges(onSaved: () => void) {
  const action = useAction();
  const queryClient = useQueryClient();
  const save = async (pending: readonly Change[]) => {
    const ok = await action.run(async () => {
      try {
        for (const { setting, before, after } of pending)
          await replaceConfigValue(setting.path, before, after, absent);
      } finally {
        await queryClient.invalidateQueries({ queryKey: serverKeys.config });
      }
    }, t("config.review.saved"));
    if (ok) onSaved();
  };
  return { action, save };
}

/** The open group: its heading (with the way back on a phone) and its rows. */
function GroupPanel({
  group,
  isNarrow,
  onBack,
  children,
}: {
  group: Group;
  isNarrow: boolean;
  onBack: () => void;
  children: ReactNode;
}) {
  const heading = <SectionHeading title={t(`config.group.${group}`)} />;
  return (
    <VStack gap={4} id="settings-group">
      {isNarrow ? (
        <Toolbar
          label={t(`config.group.${group}`)}
          gap={2}
          startContent={
            <>
              <Button
                label={t("config.nav.back")}
                variant="ghost"
                size="sm"
                isIconOnly
                icon={<Icon icon={ArrowLeft} size="sm" />}
                onClick={onBack}
              />
              {heading}
            </>
          }
        />
      ) : (
        heading
      )}
      {children}
    </VStack>
  );
}

/**
 * The changed settings across all groups, kept while the operator moves between them. `round` is
 * bumped when the draft is dropped, so the controls' typed text starts again from the file.
 */
function useDraft(config: Config | undefined) {
  const [draft, setDraft] = useState<Draft>({});
  const [round, setRound] = useState(0);
  const pending = config ? changes(config, draft) : [];
  useUnsavedChanges(pending.length > 0);
  return {
    draft,
    round,
    pending,
    set: (path: string, value: unknown) => setDraft((d) => ({ ...d, [path]: value })),
    reset: () => {
      setDraft({});
      setRound((n) => n + 1);
    },
  };
}

/**
 * The open group, `?section=` in the hash; none on a phone until one is picked. An old
 * `#config/<section>` or `#config/config.yaml` link lands on the YAML, which holds it.
 */
function useGroup(isNarrow: boolean) {
  const [params, setParams] = useHashParams();
  const legacy = useHashRoute().arg;
  useEffect(() => {
    if (legacy) location.replace("#settings?section=advanced");
  }, [legacy]);
  const fallback = isNarrow ? null : groups[0];
  const group: Group | null = isGroup(params.section)
    ? params.section
    : legacy
      ? "advanced"
      : fallback;
  const select = (next: Group | null) => setParams({ section: next ?? undefined }, "push");
  return { group, select };
}

export default function Configuration() {
  const config = useConfig();
  const isNarrow = useMediaQuery(layout.phone);
  const { group, select } = useGroup(isNarrow);
  const draft = useDraft(config.data);
  const [isReviewing, setReviewing] = useState(false);
  const close = () => {
    setReviewing(false);
    draft.reset();
  };
  const { action, save } = useSaveChanges(close);
  const version = config.data?.["config-version"];

  const panel = group && (
    <GroupPanel group={group} isNarrow={isNarrow} onBack={() => select(null)}>
      <VStack gap={0} key={draft.round}>
        <Divider />
        <GroupRows group={group} config={config.data} draft={draft.draft} onChange={draft.set} />
        {group === "advanced" && <Advanced action={action} />}
      </VStack>
    </GroupPanel>
  );

  return (
    <PageFrame
      title={t("app.nav.config")}
      meta={
        config.data && (
          <Text type="supporting" color="secondary">
            {version ? t("config.page.layout", { version }) : t("config.page.legacy")}
          </Text>
        )
      }
      actions={
        <Button
          label={t("config.save.button")}
          variant="primary"
          isLoading={action.busy}
          onClick={() =>
            draft.pending.length ? setReviewing(true) : notify("info", t("config.save.none"))
          }
        />
      }
    >
      {config.isError && (
        <ReadError
          error={config.error}
          what={t("config.page.what")}
          retry={() => void config.refetch()}
        />
      )}
      {config.isError && !config.data ? null : isNarrow ? (
        (panel ?? <GroupList active={null} isNarrow onSelect={select} />)
      ) : (
        <Layout
          start={
            <LayoutPanel hasDivider padding={0} label={t("config.nav.label")}>
              <GroupList active={group} isNarrow={false} onSelect={select} />
            </LayoutPanel>
          }
          content={<LayoutContent padding={4}>{panel}</LayoutContent>}
        />
      )}
      {isReviewing && (
        <ReviewDialog
          pending={draft.pending}
          busy={action.busy}
          onSave={() => void save(draft.pending)}
          onDiscard={close}
          onClose={() => setReviewing(false)}
        />
      )}
    </PageFrame>
  );
}
