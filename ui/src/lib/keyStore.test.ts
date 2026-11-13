import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { dropLegacyKey, forget, onForgotten } from "./keyStore.ts";

const storageAccess = mock.fn(() => undefined);
for (const name of ["localStorage", "sessionStorage", "indexedDB"])
  Object.defineProperty(globalThis, name, { configurable: true, get: storageAccess });

test("forget tells the other tabs once, and touches no web storage", async () => {
  // Another tab: a second listener on the channel, as a page in another tab would hold.
  const heard: string[] = [];
  const watcher = new BroadcastChannel("cook-router.session");
  watcher.onmessage = (event: MessageEvent) => heard.push(String(event.data));
  const signedOut = new Promise<void>((resolve) => {
    const stop = onForgotten(() => {
      stop();
      resolve();
    });
  });
  forget();
  await signedOut;
  // Let any echo arrive before counting.
  await new Promise((resolve) => setTimeout(resolve, 20));
  watcher.close();
  assert.deepEqual(heard, ["signed-out"]);
  assert.equal(storageAccess.mock.callCount(), 0);
});

test("other messages on the channel are not a sign-out", async () => {
  let calls = 0;
  const stop = onForgotten(() => calls++);
  const other = new BroadcastChannel("cook-router.session");
  other.postMessage("something-else");
  await new Promise((resolve) => setTimeout(resolve, 20));
  other.close();
  stop();
  assert.equal(calls, 0);
});

test("without BroadcastChannel, forget and onForgotten skip the broadcast", () => {
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

test("dropLegacyKey deletes the key older dashboards stored, and survives blocked storage", () => {
  const removed: string[] = [];
  for (const name of ["localStorage", "sessionStorage"])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: { removeItem: (key: string) => removed.push(`${name}:${key}`) },
    });
  try {
    dropLegacyKey();
    assert.deepEqual(removed, [
      "localStorage:cliproxy.managementKey",
      "sessionStorage:cliproxy.managementKey",
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    assert.doesNotThrow(dropLegacyKey);
  } finally {
    for (const name of ["localStorage", "sessionStorage"])
      Object.defineProperty(globalThis, name, { configurable: true, get: storageAccess });
  }
});
