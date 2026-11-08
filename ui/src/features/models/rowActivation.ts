// The table-filter template's row activation (`table-filter:2728-2767`): each row is one tab stop,
// a click or Enter or Space opens its detail, and the open row is one step past hover.
import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import type { TablePlugin } from "@astryxdesign/core/Table";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";

const styles = stylex.create({
  clickableRow: { cursor: "pointer" },
  activeRow: {
    backgroundColor: colorVars["--color-overlay-pressed"],
    "--table-row-overlay": colorVars["--color-overlay-pressed"],
  },
});

export function useRowActivation<T extends { key: string }>(
  openKey: string | undefined,
  onOpen: (row: T) => void,
) {
  return useMemo<TablePlugin<T>>(
    () => ({
      transformBodyRow: (props, item) => {
        const isOpen = item.key === openKey;
        return {
          ...props,
          htmlProps: {
            ...props.htmlProps,
            tabIndex: 0,
            "aria-current": isOpen ? true : undefined,
            onClick: (event: MouseEvent<HTMLTableRowElement>) => {
              // Buttons and menus in a cell own their own clicks.
              if ((event.target as HTMLElement).closest("input, button, a, [role=menu]")) return;
              onOpen(item);
            },
            onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onOpen(item);
            },
          },
          xstyle: props.xstyle.concat(
            isOpen ? [styles.clickableRow, styles.activeRow] : styles.clickableRow,
          ),
        };
      },
    }),
    [openKey, onOpen],
  );
}
