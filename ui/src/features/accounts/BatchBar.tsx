// The TableBulkActionsTable block's selection toolbar: the batch actions at the start, the count
// and Clear at the end. Every action acts on whole files and says which accounts it reaches.
// Deviation: an HStack of the same parts, not TableSelectionToolbar, whose full-bleed surface ran
// over the header's description line in PageFrame's toolbar slot and did not wrap on a phone.
import type { Dispatch, SetStateAction } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useAvailable } from "../../components/MissingActions.tsx";
import { routes } from "../../lib/api/routes.ts";
import { label } from "../../lib/credentials.ts";
import { list, t } from "../../lib/i18n.ts";
import { hiddenSelection, reach, toSwitch, type Row } from "./rows.ts";
import type { Writes } from "./writes.tsx";

type BatchProps = {
  rows: Row[];
  shown: Row[];
  tab: string;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  writes: Writes;
};

/** The batch actions, each labelled with how many accounts or files it reaches. */
function BatchActions({ rows, selected, setSelected, writes }: BatchProps) {
  const isAvailable = useAvailable();
  const files = reach(rows, selected);
  const enable = toSwitch(files, selected, false);
  const disable = toSwitch(files, selected, true);
  const deletable = files.filter((g) => !g[0].account.runtime_only).flat();
  const canSwitch = isAvailable(routes.setCredentialStatus);
  // From the selection as it is when each file goes, not as it was when the batch began.
  const drop = (keys: string[]) =>
    setSelected((now) => new Set([...now].filter((k) => !keys.includes(k))));
  return (
    <>
      {enable.length > 0 && (
        <Button
          label={t("accounts.batch.enable", { count: enable.length })}
          variant="ghost"
          isLoading={writes.isBusy("enable")}
          isDisabled={!canSwitch}
          onClick={() => writes.setStatus(rows, selected, false)}
        />
      )}
      {disable.length > 0 && (
        <Button
          label={t("accounts.batch.disable", { count: disable.length })}
          variant="ghost"
          isLoading={writes.isBusy("disable")}
          isDisabled={!canSwitch}
          onClick={() => writes.setStatus(rows, selected, true)}
        />
      )}
      <Button
        label={t("accounts.batch.refresh", { count: files.length })}
        variant="ghost"
        isLoading={writes.isBusy("refresh")}
        isDisabled={!isAvailable(routes.refreshCredentials)}
        onClick={() => void writes.refresh(files, selected)}
      />
      {deletable.length > 0 && (
        <Button
          label={t("accounts.batch.delete", { count: deletable.length })}
          variant="ghost"
          isLoading={writes.isBusy("delete")}
          isDisabled={!isAvailable(routes.deleteCredentials)}
          onClick={() => writes.remove(files, drop)}
        />
      )}
    </>
  );
}

/** How many selected accounts the view hides, and which unselected ones the actions reach. */
function reachNote({ rows, shown, tab, selected }: BatchProps, picked: Row[]) {
  const hidden = hiddenSelection(picked, shown, tab);
  const extra = reach(rows, selected)
    .flat()
    .filter((r) => !selected.has(r.key));
  return [
    hidden.count > 0 &&
      (hidden.provider
        ? t("accounts.batch.hiddenOnTab", { count: hidden.count, provider: label(hidden.provider) })
        : t("accounts.batch.hiddenByFilters", { count: hidden.count })),
    extra.length > 0 && t("accounts.batch.alsoReach", { names: list(extra.map((r) => r.name)) }),
  ]
    .filter(Boolean)
    .join(" ");
}

export function BatchBar(props: BatchProps) {
  const { rows, selected, setSelected } = props;
  const picked = rows.filter((r) => selected.has(r.key));
  if (!picked.length) return null;
  const note = reachNote(props, picked);
  const count = t("accounts.batch.selected", { count: picked.length });
  return (
    <VStack gap={1}>
      <HStack
        gap={2}
        vAlign="center"
        wrap="wrap"
        role="toolbar"
        aria-label={t("accounts.batch.label")}
      >
        <BatchActions {...props} />
        <StackItem size="fill" />
        <Text type="label">{count}</Text>
        <Button
          label={t("accounts.batch.clear")}
          variant="ghost"
          onClick={() => setSelected(new Set())}
        />
      </HStack>
      {note && (
        <Text type="supporting" color="secondary">
          {note}
        </Text>
      )}
    </VStack>
  );
}
