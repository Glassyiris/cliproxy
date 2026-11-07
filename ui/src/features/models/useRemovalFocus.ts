import { useEffect, useRef } from "react";

/**
 * A removed row takes its focused button with it. Once the list has shrunk, focus goes to the
 * button now at the removed position (or the last one), else to `fallback`, a control that stays.
 */
export function useRemovalFocus(count: number | undefined, fallback: () => HTMLElement | null) {
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const pending = useRef<{ index: number; count: number } | null>(null);
  useEffect(() => {
    const wait = pending.current;
    if (!wait || count === undefined || count >= wait.count) return;
    pending.current = null;
    (buttons.current.get(Math.min(wait.index, count - 1)) ?? fallback())?.focus();
  });
  return {
    /** The ref of the action button in row `index`. */
    bind: (index: number) => (el: HTMLButtonElement | null) => {
      if (el) buttons.current.set(index, el);
      else buttons.current.delete(index);
    },
    /** Runs the removal of row `index`; focus moves only when it was stored. */
    run: async (index: number, remove: () => Promise<boolean>) => {
      pending.current = { index, count: count ?? 0 };
      if (!(await remove())) pending.current = null;
    },
  };
}
