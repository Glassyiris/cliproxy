import { createContext, type ReactNode } from "react";

/** The parts of a dialog's frame: pinned under its title, the body that scrolls, pinned at its foot. */
export type DialogParts = { header?: ReactNode; content: ReactNode; footer?: ReactNode };

/**
 * How a hosted page (src/app/pages/) is drawn by PageFrame: in its route's header with the route's
 * title, tabs and controls, or in a dialog, whose `frame` draws the title and close button and
 * places the page's parts. Its own module, so the shell's dialogs do not pull the page frame into
 * the first load.
 */
export type PageHost =
  | { kind: "tab"; title: string; tabs: ReactNode; actions?: ReactNode }
  | { kind: "dialog"; frame: (parts: DialogParts) => ReactNode };

export const PageHostContext = createContext<PageHost | null>(null);
