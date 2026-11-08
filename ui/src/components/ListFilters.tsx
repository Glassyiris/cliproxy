import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Icon } from "@astryxdesign/core/Icon";
import { TextInput } from "@astryxdesign/core/TextInput";
import { t } from "../lib/i18n.ts";

type Filters = { view: "needs" | "all"; search: string };

export function ListFilters({
  filters,
  setFilters,
  needs,
  total,
  isStacked,
  searchLabel,
  searchHint,
  selectors,
  children,
}: {
  filters: Filters;
  setFilters: (changes: Partial<Filters>) => void;
  needs: number;
  total: number;
  isStacked: boolean;
  searchLabel: string;
  searchHint: string;
  selectors: ReactNode;
  children?: ReactNode;
}) {
  const views = (
    <SegmentedControl
      label={t("app.list.view")}
      value={filters.view}
      onChange={(view) => setFilters({ view: view === "all" ? "all" : "needs" })}
    >
      <SegmentedControlItem value="needs" label={t("app.list.needs", { count: needs })} />
      <SegmentedControlItem value="all" label={t("app.list.all", { count: total })} />
    </SegmentedControl>
  );
  return (
    <VStack gap={3}>
      {isStacked && views}
      <HStack gap={3} vAlign="center" wrap="wrap">
        {!isStacked && views}
        {selectors}
        <TextInput
          type="search"
          startIcon={<Icon icon={Search} size="sm" />}
          label={searchLabel}
          isLabelHidden
          placeholder={searchHint}
          value={filters.search}
          onChange={(search) => setFilters(search ? { search, view: "all" } : { search })}
          hasClear
        />
        {children}
      </HStack>
    </VStack>
  );
}
