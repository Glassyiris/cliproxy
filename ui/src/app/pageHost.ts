import { createContext, type ReactNode } from "react";

/**
 * How a hosted page (src/app/pages/) is drawn by PageFrame: in its route's header with the route's
 * title, tabs and controls, or in a dialog under the dialog's title. Its own module, so the shell's
 * dialogs do not pull the page frame into the first load.
 */
export type PageHost =
  { kind: "tab"; title: string; tabs: ReactNode; actions?: ReactNode } | { kind: "dialog" };

export const PageHostContext = createContext<PageHost | null>(null);
