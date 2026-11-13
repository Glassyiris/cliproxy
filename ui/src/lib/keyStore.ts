// The dashboard stores no key: after sign-in the server's HttpOnly session cookie authenticates
// every request, and no script can read it. This module carries the sign-out to the other tabs,
// which share that cookie, and deletes the key older dashboards stored.

const CHANNEL = "cook-router.session";
const SIGNED_OUT = "signed-out";
/** Where dashboards before the session cookie kept the raw key. */
const LEGACY_KEY = "cliproxy.managementKey";

/** Delete the key an older dashboard stored, so an upgrade leaves no copy in the browser profile. */
export function dropLegacyKey() {
  for (const store of ["localStorage", "sessionStorage"] as const) {
    try {
      globalThis[store].removeItem(LEGACY_KEY);
    } catch {
      // Blocked storage: this page could not have written the key there either.
    }
  }
}

function channel(): BroadcastChannel | null {
  try {
    return new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

/** Sign-out: tell the other tabs to sign out too. */
export function forget() {
  const out = channel();
  out?.postMessage(SIGNED_OUT);
  out?.close();
}

/**
 * Run `listener` when a tab signs out. The signing-out tab hears its own message too, through this
 * second channel object; the listener must ignore it there. Returns the unsubscribe function.
 */
export function onForgotten(listener: () => void): () => void {
  const into = channel();
  if (!into) return () => {};
  into.onmessage = (event: MessageEvent) => {
    if (event.data === SIGNED_OUT) listener();
  };
  return () => into.close();
}
