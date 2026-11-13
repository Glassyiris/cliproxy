import { useHashParams } from "./useHashRoute.ts";

/**
 * The one way to start connecting an account; every "Connect an account" control calls it. It opens
 * the Connect dialog over the page shown, through the hash so the unsaved-changes guard still asks.
 */
export function useConnectAccount(): () => void {
  const [, setParams] = useHashParams();
  return () => setParams({ open: "connect" }, "push");
}
