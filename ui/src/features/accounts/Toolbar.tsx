// The template's filter row: provider tabs, the quick filters and search on one side, the
// collection's own actions on the other; it wraps under the filters on a narrow screen.
import { RefreshCw } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { useAvailable } from "../../components/MissingActions.tsx";
import { routes } from "../../lib/api/routes.ts";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import type { Filters, Show } from "./rows.ts";
import type { Writes } from "./writes.tsx";

const showLabel: Record<Show, () => string> = {
  ready: () => t("accounts.filters.ready"),
  low: () => t("accounts.filters.low"),
  attention: () => t("accounts.filters.attention"),
};

/** Upload credential JSON files; the field empties again once they are sent. */
export function UploadInput({ writes }: { writes: Writes }) {
  const isAvailable = useAvailable();
  return (
    <FileInput
      label={t("accounts.actions.upload")}
      isLabelHidden
      placeholder={t("accounts.actions.upload")}
      accept=".json,application/json"
      isMultiple
      value={[]}
      isLoading={writes.isBusy("upload")}
      isDisabled={!isAvailable(routes.uploadCredentials)}
      onChange={(files) => {
        const list = Array.isArray(files) ? files : files ? [files] : [];
        if (list.length) void writes.upload(list);
      }}
    />
  );
}

export function Toolbar({
  filters,
  setFilters,
  tabs,
  total,
  quick,
  writes,
  checking,
  canCheck,
  onCheck,
}: {
  filters: Filters;
  setFilters: (changes: Partial<Filters>) => void;
  tabs: [string, number][];
  total: number;
  quick: Record<Show, number>;
  writes: Writes;
  checking: boolean;
  canCheck: boolean;
  onCheck: () => void;
}) {
  return (
    <HStack gap={3} vAlign="center" wrap="wrap">
      {/* One segment per provider can be wider than a phone or the table beside the panel. */}
      <ScrollableArea axis="inline" label={t("accounts.filters.provider")} maxWidth="100%">
        <SegmentedControl
          label={t("accounts.filters.provider")}
          value={filters.provider || "all"}
          onChange={(p) => setFilters({ provider: p === "all" ? "" : p })}
        >
          <SegmentedControlItem value="all" label={t("accounts.filters.all", { count: total })} />
          {tabs.map(([p, n]) => (
            <SegmentedControlItem
              key={p}
              value={p}
              label={t("accounts.filters.tab", { provider: label(p), count: n })}
            />
          ))}
        </SegmentedControl>
      </ScrollableArea>
      <HStack gap={1} vAlign="center">
        {(Object.keys(showLabel) as Show[]).map((s) => (
          <ToggleButton
            key={s}
            size="sm"
            label={t("accounts.filters.count", { name: showLabel[s](), count: quick[s] })}
            isPressed={filters.show === s}
            onPressedChange={(on) => setFilters({ show: on ? s : "" })}
          />
        ))}
      </HStack>
      <TextInput
        type="search"
        label={t("accounts.filters.search")}
        isLabelHidden
        placeholder={t("accounts.filters.searchHint")}
        value={filters.search}
        onChange={(search) => setFilters({ search })}
        hasClear
      />
      <HStack gap={2} vAlign="center">
        <UploadInput writes={writes} />
        <Button
          label={checking ? t("accounts.actions.checking") : t("accounts.actions.checkQuotas")}
          icon={<Icon icon={RefreshCw} size="sm" />}
          isLoading={checking}
          isDisabled={!canCheck}
          onClick={onCheck}
        />
      </HStack>
    </HStack>
  );
}
