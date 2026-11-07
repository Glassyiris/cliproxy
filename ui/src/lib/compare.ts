export function equal(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  );
}

/** Reuse previous objects that did not change, so keyed lists skip unchanged rows. */
export function reconcile<T extends object>(prev: T[], next: T[], key: (v: T) => string): T[] {
  const old = new Map(prev.map((v) => [key(v), v]));
  return next.map((v) => {
    const p = old.get(key(v));
    return p && equal(p, v) ? p : v;
  });
}

export function lineDiff(before: string, after: string): { kind: string; text: string }[] {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0,
    end = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (
    end < Math.min(a.length, b.length) - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return [
    ...a.slice(0, start).map((text) => ({ kind: "same", text })),
    ...a.slice(start, a.length - end).map((text) => ({ kind: "removed", text })),
    ...b.slice(start, b.length - end).map((text) => ({ kind: "added", text })),
    ...a.slice(a.length - end).map((text) => ({ kind: "same", text })),
  ];
}
