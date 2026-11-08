// Template: settings-sidebar, with its group list as a tab strip under the page header.
// The strip scrolls on a phone, so one layout serves every width.
// Deviations:
// - In PageFrame with its LayoutHeader and h1 (DESIGN.md "Roles", Header): the template has no
//   header, and its own nav heading ("Account settings") would duplicate the h1.
// - Rows are label and hint beside the control on a two-column Grid, not the template's
//   expand-to-edit rows: every setting is a control that edits in place, and one Save in the header
//   reviews all changes as a diff first, which per-row Save buttons cannot show.
// - The group is `?section=` in the hash, so Back and reload keep it; the template keeps it in state.
// - Icons are lucide, not heroicons; the "Professional hosting tools" list and the info cards are
//   omitted because cliproxy has no counterpart.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileCode, KeyRound, Globe, Route, ScrollText, Send } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon, type IconProps } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { icons } from "../../components/icons.ts";
import { PageFrame } from "../../app/PageFrame.tsx";
import { serverKeys, useConfig } from "../../app/serverQueries.ts";
import { useAction } from "../../app/useAction.ts";
import { useHashParams, useHashRoute, useUnsavedChanges } from "../../app/useHashRoute.ts";
import { ReadError } from "../../components/ReadError.tsx";
import { hinted } from "../../i18n/config.ts";
import { replaceConfigValue, type Config } from "../../lib/api/config.ts";
import { absent } from "../../lib/configPath.ts";
import { t } from "../../lib/i18n.ts";
import { notify } from "../../lib/notify.ts";
import { Advanced } from "./Advanced.tsx";
import { Access } from "./Access.tsx";
import { ReviewDialog } from "./ReviewDialog.tsx";
import { Control, isWide, Row } from "./SettingRow.tsx";
import {
  changes,
  editDraft,
  groups,
  settingId,
  settingsOf,
  shown,
  type Change,
  type Draft,
  type Group,
} from "./settings.ts";

const groupIcons: Record<Group, IconProps["icon"]> = {
  routing: Route,
  access: KeyRound,
  network: Globe,
  requests: Send,
  logging: ScrollText,
  advanced: FileCode,
};

const isGroup = (value: string | undefined): value is Group =>
  (groups as readonly string[]).includes(value ?? "");

const panelId = "settings-group";

type Hinted = (typeof hinted)[number];
/** A setting's hint, for the few whose label alone does not say what to enter. */
const hintOf = (id: string) =>
  (hinted as readonly string[]).includes(id) ? t(`config.hint.${id as Hinted}`) : undefined;

function GroupTabs({ active, onSelect }: { active: Group; onSelect: (group: Group) => void }) {
  return (
    <VStack id="settings-nav">
      <TabList
        role="tablist"
        aria-label={t("config.nav.label")}
        isFullBleed
        value={active}
        onChange={(value) => isGroup(value) && onSelect(value)}
      >
        {groups.map((group) => (
          <Tab
            key={group}
            value={group}
            label={t(`config.group.${group}`)}
            icon={<Icon icon={groupIcons[group]} size="sm" />}
            panelId={panelId}
          />
        ))}
      </TabList>
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
        hint={hintOf(settingId(setting))}
        note={setting.restart ? t("config.row.restart") : undefined}
        isStacked={isWide(setting)}
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

/**
 * The changed settings across all groups, kept while the operator moves between them. `round` is
 * bumped when the draft is dropped, so the controls' typed text starts again from the file.
 */
function useDraft(config: Config | undefined) {
  const [state, setDraft] = useState<{ values: Draft; baseline: Draft }>({
    values: {},
    baseline: {},
  });
  const draft = state.values;
  const [round, setRound] = useState(0);
  const pending = config ? changes(config, draft, state.baseline) : [];
  useUnsavedChanges(pending.length > 0);
  return {
    draft,
    round,
    pending,
    set: (path: string, value: unknown) =>
      setDraft((d) => (config ? editDraft(config, d.values, path, value, d.baseline) : d)),
    reset: () => {
      setDraft({ values: {}, baseline: {} });
      setRound((n) => n + 1);
    },
  };
}

/**
 * The open group, `?section=` in the hash; the first by default. An old `#config/<section>` or
 * `#config/config.yaml` link lands on Advanced with that section's editor open (`?key=`).
 */
function useGroup() {
  const [params, setParams] = useHashParams();
  const legacy = useHashRoute().arg;
  useEffect(() => {
    if (legacy)
      location.replace(`#settings?${new URLSearchParams({ section: "advanced", key: legacy })}`);
  }, [legacy]);
  const group: Group = isGroup(params.section) ? params.section : legacy ? "advanced" : groups[0];
  const select = (next: Group) => setParams({ section: next }, "push");
  return { group, select };
}

export default function Configuration() {
  const config = useConfig();
  const { group, select } = useGroup();
  const draft = useDraft(config.data);
  const [isReviewing, setReviewing] = useState(false);
  const close = () => {
    setReviewing(false);
    draft.reset();
  };
  const { action, save } = useSaveChanges(close);
  const version = config.data?.["config-version"];

  return (
    <PageFrame
      title={t("app.nav.config")}
      meta={
        config.data &&
        !version && (
          <Text type="supporting" color="secondary">
            {t("config.page.legacy")}
          </Text>
        )
      }
      actions={
        <Button
          label={t("config.save.button")}
          variant="primary"
          icon={<Icon icon={icons.save} />}
          isLoading={action.busy}
          onClick={() =>
            draft.pending.length ? setReviewing(true) : notify("info", t("config.save.none"))
          }
        />
      }
      toolbar={<GroupTabs active={group} onSelect={select} />}
    >
      {config.isError && (
        <ReadError
          error={config.error}
          what={t("config.page.what")}
          retry={() => void config.refetch()}
        />
      )}
      {config.isError && !config.data ? null : (
        <VStack gap={0} key={draft.round} id={panelId} role="tabpanel">
          <GroupRows group={group} config={config.data} draft={draft.draft} onChange={draft.set} />
          {group === "advanced" && <Advanced action={action} config={config.data} />}
        </VStack>
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
