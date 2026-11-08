// The template's filter row in the LayoutHeader (table-filter:4339-4475): the search leads and the
// family filter and the view switch follow; the row wraps on a narrow screen.
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { label } from "../../lib/credentials.ts";
import { t } from "../../lib/i18n.ts";
import { channels, isChannel, type Channel } from "./modelConfig.ts";

// Selector holds no empty value, so "every family" has a name of its own.
const ALL = "all";
export type View = "models" | "rules";

export function Toolbar({
  query,
  family,
  view,
  onQuery,
  onFamily,
  onView,
}: {
  query: string;
  family: Channel | undefined;
  view: View;
  onQuery: (query: string) => void;
  onFamily: (family: Channel | undefined) => void;
  onView: (view: View) => void;
}) {
  return (
    <HStack gap={3} vAlign="center" wrap="wrap">
      <StackItem size="fill">
        <TextInput
          type="search"
          label={view === "models" ? t("models.filter.search") : t("models.filter.searchRules")}
          isLabelHidden
          placeholder={
            view === "models" ? t("models.filter.search") : t("models.filter.searchRules")
          }
          value={query}
          onChange={onQuery}
          startIcon={<Icon icon="search" size="sm" />}
          hasClear
        />
      </StackItem>
      <Selector
        label={t("models.col.family")}
        isLabelHidden
        value={family ?? ALL}
        options={[
          { value: ALL, label: t("models.filter.allFamilies") },
          ...channels.map((id) => ({ value: id, label: label(id) })),
        ]}
        onChange={(value) => onFamily(isChannel(value) ? value : undefined)}
      />
      <SegmentedControl
        label={t("models.filter.view")}
        value={view}
        onChange={(value) => onView(value === "rules" ? "rules" : "models")}
      >
        <SegmentedControlItem value="models" label={t("models.filter.models")} />
        <SegmentedControlItem value="rules" label={t("models.filter.rules")} />
      </SegmentedControl>
    </HStack>
  );
}
