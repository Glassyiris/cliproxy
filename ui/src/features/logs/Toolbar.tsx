// The template's filter row in the page header: the search leads (lines, request IDs among them,
// or error log file names), then the log choice and, for the application log, its level and the
// management calls switch, and the count of what is shown. Clear sits in the header's More menu;
// the row wraps on a narrow screen.
import { useEffect, useState, type ReactNode, type Ref, type RefObject } from "react";
import { Ellipsis } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { Action } from "../../app/useAction.ts";
import { t } from "../../lib/i18n.ts";
import type { LevelFilter } from "./lines.ts";

export type LogSource = "app" | "errors";
export type Filters = { filter: string; withManagement: boolean; level: LevelFilter };

/** A search that is one token reads as a request ID: Enter opens that request's log. */
export const requestIdOf = (query: string) => {
  const id = query.trim();
  return id && !/\s/.test(id) ? id : "";
};

const isLevel = (value: string): value is LevelFilter =>
  value === "" || value === "warn" || value === "error";

export function Toolbar({
  ref,
  source,
  setSource,
  filters,
  setFilters,
  onOpen,
  count,
}: {
  ref: Ref<HTMLDivElement>;
  source: LogSource;
  setSource: (source: LogSource) => void;
  filters: Filters;
  setFilters: (changes: Partial<Filters>) => void;
  onOpen: (id: string) => void;
  count: ReactNode;
}) {
  const isApp = source === "app";
  return (
    <HStack gap={3} vAlign="center" wrap="wrap" ref={ref}>
      <StackItem size="fill">
        <TextInput
          type="search"
          label={isApp ? t("logs.filters.search") : t("logs.filters.searchFiles")}
          isLabelHidden
          placeholder={isApp ? t("logs.filters.search") : t("logs.filters.searchFiles")}
          value={filters.filter}
          onChange={(filter) => setFilters({ filter })}
          onEnter={() => {
            const id = isApp && requestIdOf(filters.filter);
            if (id) onOpen(id);
          }}
          startIcon={<Icon icon="search" size="sm" />}
          hasClear
        />
      </StackItem>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <SegmentedControl
          label={t("logs.filters.source")}
          value={source}
          onChange={(value) => setSource(value === "errors" ? "errors" : "app")}
        >
          <SegmentedControlItem value="app" label={t("logs.tabs.app")} />
          <SegmentedControlItem value="errors" label={t("logs.tabs.errors")} />
        </SegmentedControl>
        {isApp && (
          <>
            <Selector
              label={t("logs.filters.level")}
              isLabelHidden
              value={filters.level}
              onChange={(level) => isLevel(level) && setFilters({ level })}
              options={[
                { value: "", label: t("logs.filters.allLevels") },
                { value: "warn", label: t("logs.filters.warn") },
                { value: "error", label: t("logs.filters.error") },
              ]}
            />
            <CheckboxInput
              label={t("logs.filters.management")}
              value={filters.withManagement}
              onChange={(withManagement) => setFilters({ withManagement })}
            />
          </>
        )}
        {count}
      </HStack>
    </HStack>
  );
}

/**
 * The header's More menu with Clear, after the question; the dialog stays open and busy until the
 * server answers. A first empty 404 marks Clear unavailable: the question goes with it, and focus
 * goes to the search in `searchRow` instead of the menu.
 */
export function MoreMenu({
  action,
  canClear,
  onClear,
  searchRow,
}: {
  action: Action;
  canClear: boolean;
  onClear: () => Promise<void>;
  searchRow: RefObject<HTMLElement | null>;
}) {
  const [isAsking, setIsAsking] = useState(false);
  const [isWithdrawn, setIsWithdrawn] = useState(false);
  if (isAsking && !canClear && !action.busy) {
    setIsAsking(false);
    setIsWithdrawn(true);
  }
  useEffect(() => {
    if (isWithdrawn) searchRow.current?.querySelector("input")?.focus();
  }, [isWithdrawn, searchRow]);
  const label = t("logs.more.label");
  return (
    <>
      <DropdownMenu
        button={{
          label,
          tooltip: label,
          icon: <Icon icon={Ellipsis} size="sm" />,
          isIconOnly: true,
          variant: "ghost",
        }}
        hasChevron={false}
        alignment="end"
        items={[
          {
            label: t("logs.clear.button"),
            variant: "destructive",
            isDisabled: !canClear,
            onClick: () => setIsAsking(true),
          },
        ]}
      />
      <AlertDialog
        isOpen={isAsking}
        onOpenChange={(open) => !open && !action.busy && setIsAsking(false)}
        title={t("logs.clear.title")}
        description={t("logs.clear.description")}
        actionLabel={t("logs.clear.action")}
        cancelLabel={t("logs.clear.cancel")}
        isActionLoading={action.busy}
        onAction={async () => {
          if (action.busy || !canClear) return;
          if (await action.run(onClear, t("logs.clear.done"))) setIsAsking(false);
        }}
      />
    </>
  );
}
