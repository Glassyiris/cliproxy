// The keyboard of a list whose rows open a detail panel (Accounts, Provider keys), as table-inbox
// wires its rows: Enter or Space opens or closes the row's panel, Escape closes it, the arrows,
// Home and End move between rows. Closing the panel brings focus back to the row that opened it.
import { useEffect, useRef, type KeyboardEvent } from "react";

/** table-inbox `INTERACTIVE_WITHIN_ROW`: controls inside the row that are not the row. */
export const isRowItself = (target: EventTarget | null) =>
  !(target as HTMLElement | null)?.closest(
    'button, input, a, label, [role="checkbox"], [role="button"], [role="menuitem"], [role="img"]',
  );

/** Where an arrow, Home or End key moves from the row at `index` (clamped later); else null. */
function moveOf(key: string, index: number) {
  if (key === "ArrowDown") return index + 1;
  if (key === "ArrowUp") return index - 1;
  if (key === "Home") return 0;
  if (key === "End") return Infinity;
  return null;
}

/**
 * A row's key press: a move goes to `moveTo` (the index unclamped), Enter or Space toggles the
 * row's panel, Escape closes it while it is open. Keys pressed on a control inside the row are
 * the control's.
 */
export function onRowKey(
  event: KeyboardEvent,
  row: { index: number; isOpen: boolean; toggle: () => void },
  moveTo: (index: number) => void,
) {
  if (!isRowItself(event.target)) return;
  const to = moveOf(event.key, row.index);
  if (to !== null) {
    event.preventDefault();
    moveTo(to);
  } else if (event.key === "Enter" || event.key === " " || (event.key === "Escape" && row.isOpen)) {
    event.preventDefault();
    row.toggle();
  }
}

/** The body row at `index` under `holder`, when it is rendered. */
export const rowAt = (holder: HTMLElement | null, index: number) =>
  holder?.querySelector<HTMLElement>(`tbody tr[data-index="${index}"]`) ?? null;

/**
 * When the panel closes, focus returns to the row that opened it: `reveal` scrolls it into a
 * windowed list first and says whether the row is still listed; `rowOf` finds it once rendered.
 */
export function useReturnFocus(
  openId: string,
  reveal: (id: string) => boolean,
  rowOf: (id: string) => HTMLElement | null,
) {
  const opened = useRef(openId);
  useEffect(() => {
    const was = opened.current;
    opened.current = openId;
    if (!was || openId || !reveal(was)) return;
    requestAnimationFrame(() => rowOf(was)?.focus({ preventScroll: true }));
  }, [openId, reveal, rowOf]);
}
