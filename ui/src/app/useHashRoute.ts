import { useEffect, useState } from "react";
import { parseHash } from "./routes.ts";

/** The current page from location.hash; `navigated` turns true after the first hash change. */
export function useHashRoute() {
  const [state, setState] = useState(() => ({ ...parseHash(location.hash), navigated: false }));
  useEffect(() => {
    const sync = () =>
      setState((s) => {
        const next = parseHash(location.hash);
        return next.route === s.route && next.arg === s.arg ? s : { ...next, navigated: true };
      });
    addEventListener("hashchange", sync);
    return () => removeEventListener("hashchange", sync);
  }, []);
  return state;
}
