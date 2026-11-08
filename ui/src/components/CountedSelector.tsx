import { HStack, StackItem } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { roles } from "../themes/site/roles.ts";

/**
 * One line per option, its row count at the end: as a second line the count doubled every
 * option's height and the family menu scrolled (owner, 2026-11-08, screenshot).
 */
function CountedOption({ label, count }: { label: string; count: number | undefined }) {
  return (
    <HStack gap={3} vAlign="center" wrap="nowrap" width="100%">
      <StackItem size="fill">
        <Text type={roles.textType.body}>{label}</Text>
      </StackItem>
      {count !== undefined && (
        <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
          {count}
        </Text>
      )}
    </HStack>
  );
}

// Selector holds no empty value, so "every value" has a name no option can take.
const ALL = "\u0000all";

/**
 * A list's filter Selector (Accounts, Provider keys): a first option that keeps every row, then
 * each value with how many rows it keeps. `value` and `onChange` use "" for the first option.
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
  const counts = new Map(options.map((o) => [o.value, o.count]));
  return (
    <Selector
      label={label}
      isLabelHidden
      value={value || ALL}
      onChange={(v) => onChange(v === ALL ? "" : v)}
      options={[
        { value: ALL, label: allLabel },
        ...options.map((o) => ({ value: o.value, label: o.label })),
      ]}
      renderOption={(o) => <CountedOption label={o.label ?? o.value} count={counts.get(o.value)} />}
    />
  );
}
