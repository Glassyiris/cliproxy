/**
 * The one way to start connecting an account; every "Connect an account" control calls it. It opens
 * the Connect page today, through the hash so the unsaved-changes guard still asks.
 */
export function useConnectAccount(): () => void {
  return () => {
    location.hash = "#connect";
  };
}
