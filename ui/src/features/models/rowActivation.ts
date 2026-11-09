// The table-filter template's row activation: each row is one tab stop,
// a click or Enter or Space opens its detail, and the open row is one step past hover. When the
// detail closes and takes focus with it, focus goes back to the row, as rowKeys does for Accounts.
import { rowStyles } from "../../components/rowStyles.ts";
import { useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import type { TablePlugin } from "@astryxdesign/core/Table";

export function useRowActivation<T extends { key: string }>(
  openKey: string | undefined,
  onOpen: (row: T) => void,
) {
  const opened = useRef(openKey);
  useEffect(() => {
    const was = opened.current;
    opened.current = openKey;
    if (!was || openKey) return;
    requestAnimationFrame(() => {
      // Only focus that the closing panel dropped; a move made on purpose stays.
      if (document.activeElement && document.activeElement !== document.body) return;
      document.querySelector<HTMLElement>(`tr[data-row-key="${CSS.escape(was)}"]`)?.focus();
    });
  }, [openKey]);
  return useMemo<TablePlugin<T>>(
    () => ({
      transformBodyRow: (props, item) => {
        const isOpen = item.key === openKey;
        return {
          ...props,
          htmlProps: {
            ...props.htmlProps,
            tabIndex: 0,
            "data-row-key": item.key,
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
            isOpen ? [rowStyles.clickableRow, rowStyles.activeRow] : rowStyles.clickableRow,
          ),
        };
      },
    }),
    [openKey, onOpen],
  );
}
