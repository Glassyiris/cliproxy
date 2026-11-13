// The dashboard stores no key: after sign-in the server's HttpOnly session cookie authenticates
// every request, and no script can read it. This module carries the sign-out to the other tabs,
// which share that cookie.

const CHANNEL = "cooker.session";
const SIGNED_OUT = "signed-out";
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
