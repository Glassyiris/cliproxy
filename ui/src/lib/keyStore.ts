// The management key uses session storage by default, and local storage only when the operator
// ticks "Remember on this device". The API client still reads the
// key from its own memory; storage is read once, at load.
//
// A store that throws (blocked site data, a private window) counts as holding nothing.

const STORAGE_KEY = "cliproxy.managementKey";
const CHANNEL = "cook-router.session";
const SIGNED_OUT = "signed-out";

type Store = "sessionStorage" | "localStorage";

function read(store: Store): string | null {
  try {
    return globalThis[store].getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function write(store: Store, key: string | null) {
  try {
    if (key === null) globalThis[store].removeItem(STORAGE_KEY);
    else globalThis[store].setItem(STORAGE_KEY, key);
  } catch {
    // Nothing is stored; the next load shows the sign-in form.
  }
}

function clear() {
  write("sessionStorage", null);
  write("localStorage", null);
}

function channel(): BroadcastChannel | null {
  try {
    return new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

/** Keep `key` for this tab, and on this device too when `persist`; otherwise drop the device copy. */
export function remember(key: string, persist: boolean) {
  write("sessionStorage", key);
  write("localStorage", persist ? key : null);
}

/** The stored key: this tab's first, then the device's. */
export function recall(): string | null {
  return read("sessionStorage") ?? read("localStorage");
}

/**
 * Drop a key the server refused, from each store that holds exactly that key, and tell no one: a
 * key typed later in another tab (after the old one was rotated) stays, and so does its session.
 */
export function discard(key: string) {
  for (const store of ["sessionStorage", "localStorage"] as const)
    if (read(store) === key) write(store, null);
}

/** Sign-out: drop the key from both stores and tell the other tabs to sign out too. */
export function forget() {
  clear();
  const out = channel();
  out?.postMessage(SIGNED_OUT);
  out?.close();
}

/**
 * Run `listener` when a tab signs out, after this tab's stores are cleared (without telling the
 * others again). The signing-out tab hears its own message too, through this second channel
 * object; the listener must ignore it there. Returns the unsubscribe function.
 */
export function onForgotten(listener: () => void): () => void {
  const into = channel();
  if (!into) return () => {};
  into.onmessage = (event: MessageEvent) => {
    if (event.data !== SIGNED_OUT) return;
    clear();
    listener();
  };
  return () => into.close();
}
