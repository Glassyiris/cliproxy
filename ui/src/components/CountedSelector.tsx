import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
import { Text } from "@astryxdesign/core/Text";
import { layout } from "../themes/site/layout.ts";
import { roles } from "../themes/site/roles.ts";

// A first value no option can take, for "keep every row".
const ALL = "\u0000all";

/**
 * A list's filter (Accounts, Provider keys): a first option that keeps every row, then each value
 * with how many rows it keeps, the count at the row's end. A DropdownMenu of radio rows, not a
 * Selector: Selector's list stops at 300 px in Astryx 0.7.11, which scrolled an eight-status menu
 * on a tall screen (owner, 2026-11-08: 「夠長的話其實不用那麼限高。」). `value` and `onChange` use
 * "" for the first option.
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
  return (
    <DropdownMenu
      button={{ label: current, "aria-label": `${label}: ${current}` }}
      menuMaxHeight={layout.menuMaxHeight}
    >
      <DropdownMenuRadioGroup
        label={label}
        value={value || ALL}
        onChange={(v) => onChange(v === ALL ? "" : v)}
      >
        <DropdownMenuRadioItem value={ALL} label={allLabel} />
        {options.map((o) => (
          <DropdownMenuRadioItem
            key={o.value}
            value={o.value}
            label={o.label}
            endContent={
              <Text type={roles.textType.supporting} color="secondary" hasTabularNumbers>
                {o.count}
              </Text>
            }
          />
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenu>
  );
}
