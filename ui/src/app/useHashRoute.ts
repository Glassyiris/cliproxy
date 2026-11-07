import { useEffect, useState } from "react";
import { parseHash } from "./routes.ts";

/** The current page from location.hash. */
export function useHashRoute() {
  const [state, setState] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const sync = () =>
      setState((s) => {
        const next = parseHash(location.hash);
        return next.route === s.route && next.arg === s.arg ? s : next;
      });
    addEventListener("hashchange", sync);
    return () => removeEventListener("hashchange", sync);
  }, []);
  return state;
}
