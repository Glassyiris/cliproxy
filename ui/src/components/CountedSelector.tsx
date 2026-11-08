import { Check } from "lucide-react";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { layout } from "../themes/site/layout.ts";
import { roles } from "../themes/site/roles.ts";

/** The row's end: its count, then a check on the chosen row (an empty slot keeps counts aligned). */
function RowEnd({ count, isChosen }: { count: number | undefined; isChosen: boolean }) {
  return (
    <HStack gap={2} vAlign="center" wrap="nowrap">
      {count !== undefined && (
        <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
          {count}
        </Text>
      )}
      {isChosen ? (
        <Icon icon={Check} size="sm" color="primary" />
      ) : (
        <VStack width={layout.smallIcon} aria-hidden="true" />
      )}
    </HStack>
  );
}

/**
 * A list's filter (Accounts, Provider keys): a first row that keeps every row, then each value
 * with how many rows it keeps. A DropdownMenu, not a Selector: Selector's list stops at 300 px in
 * Astryx 0.7.11, which scrolled an eight-status menu on a tall screen (owner, 2026-11-08:
 * 「夠長的話其實不用那麼限高。」). Plain rows with a check on the chosen one at the end, not
 * radio rows: a column of ten empty circles was noise (owner, 2026-11-09: 「自己品」). Values that
 * keep no rows are left out unless chosen. `value` and `onChange` use "" for the first row.
 */
export function CountedSelector({
  label,
  allLabel,
  value,
  onChange,
  options,
}: {
  label: string;
  allLabel: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; count: number }[];
}) {
  const current = options.find((o) => o.value === value)?.label ?? allLabel;
  const shown = options.filter((o) => o.count > 0 || o.value === value);
  return (
    <DropdownMenu
      button={{ label: current, "aria-label": `${label}: ${current}` }}
      menuMaxHeight={layout.menuMaxHeight}
      menuWidth={layout.filterMenuWidth}
    >
      <DropdownMenuItem
        label={allLabel}
        endContent={<RowEnd count={undefined} isChosen={!value} />}
        onClick={() => onChange("")}
      />
      {shown.map((o) => (
        <DropdownMenuItem
          key={o.value}
          label={o.label}
          endContent={<RowEnd count={o.count} isChosen={o.value === value} />}
          onClick={() => onChange(o.value)}
        />
      ))}
    </DropdownMenu>
  );
}
