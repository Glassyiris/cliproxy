import { strict as assert } from "node:assert";
import { test } from "node:test";
import { discard, forget, onForgotten, recall, remember } from "./keyStore.ts";

const STORAGE_KEY = "cliproxy.managementKey";

class MemoryStorage {
  items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

class BrokenStorage {
  getItem(): string | null {
    throw new DOMException("blocked", "SecurityError");
  }
  setItem() {
    throw new DOMException("blocked", "SecurityError");
  }
  removeItem() {
    throw new DOMException("blocked", "SecurityError");
  }
}

function install(session: object, local: object) {
  for (const [name, value] of [
    ["sessionStorage", session],
    ["localStorage", local],
  ] as const)
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function stores() {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  install(session, local);
  return { session, local };
}

test("unticked: the tab keeps the key, the device does not, and an older device copy goes", () => {
  const { session, local } = stores();
  local.setItem(STORAGE_KEY, "old");
  remember("mock", false);
  assert.equal(session.getItem(STORAGE_KEY), "mock");
  assert.equal(local.getItem(STORAGE_KEY), null);
  assert.equal(recall(), "mock");
});

test("ticked: both stores keep the key, and a new tab reads it from the device", () => {
  const { session, local } = stores();
  remember("mock", true);
  assert.equal(session.getItem(STORAGE_KEY), "mock");
  assert.equal(local.getItem(STORAGE_KEY), "mock");
  session.removeItem(STORAGE_KEY);
  assert.equal(recall(), "mock");
});

test("the tab's copy wins over the device's", () => {
  const { session, local } = stores();
  local.setItem(STORAGE_KEY, "device");
  session.setItem(STORAGE_KEY, "tab");
  assert.equal(recall(), "tab");
});

test("nothing stored reads as null", () => {
  stores();
  assert.equal(recall(), null);
});

test("forget empties both stores", () => {
  const { session, local } = stores();
  remember("mock", true);
  forget();
  assert.equal(session.getItem(STORAGE_KEY), null);
  assert.equal(local.getItem(STORAGE_KEY), null);
  assert.equal(recall(), null);
});

test("discard drops only the refused key, store by store, and tells no one", async () => {
  const { session, local } = stores();
  // This tab still holds the old key; another tab saved the new one on the device.
  session.setItem(STORAGE_KEY, "old");
  local.setItem(STORAGE_KEY, "new");
  const heard: unknown[] = [];
  const watcher = new BroadcastChannel("gnocchi.session");
  watcher.onmessage = (event: MessageEvent) => heard.push(event.data);
  discard("old");
  assert.equal(session.getItem(STORAGE_KEY), null);
  assert.equal(local.getItem(STORAGE_KEY), "new");
  discard("new");
  assert.equal(local.getItem(STORAGE_KEY), null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  watcher.close();
  assert.deepEqual(heard, []);
  install(new BrokenStorage(), new BrokenStorage());
  assert.doesNotThrow(() => discard("old"));
});

test("a throwing store holds nothing and never throws", () => {
  install(new BrokenStorage(), new BrokenStorage());
  assert.doesNotThrow(() => remember("mock", true));
  assert.equal(recall(), null);
  assert.doesNotThrow(() => forget());
  // One broken store leaves the other working.
  const local = new MemoryStorage();
  install(new BrokenStorage(), local);
  remember("mock", true);
  assert.equal(recall(), "mock");
});

test("forget tells the other tabs, which clear their stores without telling anyone again", async () => {
  const { session, local } = stores();
  remember("mock", true);
  // Another tab: a second listener on the channel, as a page in another tab would hold.
  const heard: string[] = [];
  const watcher = new BroadcastChannel("gnocchi.session");
  watcher.onmessage = (event: MessageEvent) => heard.push(String(event.data));
  const signedOut = new Promise<void>((resolve) => {
    const stop = onForgotten(() => {
      stop();
      resolve();
    });
  });
  // The sending tab is the test; restore its copy after forget to see the listener clear it.
  forget();
  session.setItem(STORAGE_KEY, "mock");
  local.setItem(STORAGE_KEY, "mock");
  await signedOut;
  assert.equal(session.getItem(STORAGE_KEY), null);
  assert.equal(local.getItem(STORAGE_KEY), null);
  // Let any echo arrive before counting.
  await new Promise((resolve) => setTimeout(resolve, 20));
  watcher.close();
  assert.deepEqual(heard, ["signed-out"]);
});

test("without BroadcastChannel, forget and onForgotten skip the broadcast", () => {
  stores();
  const saved = globalThis.BroadcastChannel;
  Object.defineProperty(globalThis, "BroadcastChannel", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    assert.doesNotThrow(() => forget());
    const stop = onForgotten(() => {});
    assert.doesNotThrow(stop);
  } finally {
    Object.defineProperty(globalThis, "BroadcastChannel", {
      value: saved,
      configurable: true,
      writable: true,
    });
  }
});
