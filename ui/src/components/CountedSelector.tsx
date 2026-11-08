import * as stylex from "@stylexjs/stylex";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { HStack, StackItem } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { t } from "../lib/i18n.ts";
import { layout } from "../themes/site/layout.ts";
import { roles } from "../themes/site/roles.ts";

// The chosen row is pressed, one step past hover, as the open row of a table is (rowActivation).
const styles = stylex.create({
  chosen: { backgroundColor: colorVars["--color-overlay-pressed"] },
});

/** A row: its label, bold when chosen, and how many rows it keeps at the end. */
function Row({ label, count, isChosen }: { label: string; count: number; isChosen: boolean }) {
  return (
    // A step of inner padding on each side, so the text does not touch the row's shade.
    <HStack gap={6} paddingInline={1} vAlign="center" wrap="nowrap">
      <StackItem size="fill">
        <Text type="inherit" weight={isChosen ? roles.textWeight.emphasis : roles.textWeight.plain}>
          {label}
        </Text>
      </StackItem>
      <Text type="inherit" color="secondary">
        {count}
      </Text>
    </HStack>
  );
}

/**
 * A list's filter (Accounts, Provider keys), after the table-filter template's filter fields: the
 * closed trigger reads the field alone, or "field: value" once a value is chosen. The menu's first
 * row keeps every row; each value then says how many rows it keeps, and the rows split between the
 * values, so the first row's count is their sum (Accounts' Ready leaves out Low). The chosen row is
 * shaded and bold, with no check or radio column (owner, 2026-11-09: 「自己品」, then the shaded
 * row over a check). A DropdownMenu, not a Selector: Selector's list stops at 300 px in Astryx
 * 0.7.11, which scrolled an eight-status menu on a tall screen (owner, 2026-11-08:
 * 「夠長的話其實不用那麼限高。」). Values that keep no rows are left out unless chosen. `value` and
 * `onChange` use "" for the first row.
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
  const chosen = options.find((o) => o.value === value);
  const trigger = chosen ? t("app.list.chosen", { field: label, value: chosen.label }) : label;
  const shown = options.filter((o) => o.count > 0 || o.value === value);
  const total = options.reduce((sum, o) => sum + o.count, 0);
  const rows = [{ value: "", label: allLabel, count: total }, ...shown];
  return (
    <DropdownMenu
      button={{ label: trigger }}
      menuMaxHeight={layout.menuMaxHeight}
      menuWidth="max-content"
    >
      {rows.map((o) => (
        <DropdownMenuItem
          key={o.value}
          label={<Row label={o.label} count={o.count} isChosen={o.value === value} />}
          xstyle={o.value === value ? styles.chosen : undefined}
          onClick={() => onChange(o.value)}
        />
      ))}
    </DropdownMenu>
  );
}
