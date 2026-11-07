// The one way to tell the user something happened. DESIGN.md "Notifications" fixes where each
// level goes: success and info are a toast that hides itself, an error is a toast that stays,
// and a warning is a banner on the page until it is dismissed or the page changes. A warning
// about a lasting state (an account cooling) is not sent here: the page renders it from its data
// and it stays while the state lasts.
export type NoticeLevel = "success" | "info" | "warning" | "error";
export type Notice = { id: number; level: NoticeLevel; message: string };

const listeners = new Set<(notice: Notice) => void>();
let next = 0;

export function notify(level: NoticeLevel, message: string) {
  const notice = { id: ++next, level, message };
  for (const listener of listeners) listener(notice);
}

/**
 * Where a level is shown. Astryx 0.7.11 toasts have only `info` and `error` (Toast/types.d.ts), so
 * success rides on `info`.
 */
export function placement(level: NoticeLevel) {
  if (level === "warning") return { surface: "banner" } as const;
  const error = level === "error";
  return { surface: "toast", type: error ? "error" : "info", autoHide: !error } as const;
}

/** The shell's toast viewport and page banner subscribe here. */
export function onNotice(listener: (notice: Notice) => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
