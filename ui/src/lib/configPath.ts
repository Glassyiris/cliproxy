export function fieldPath(path: string): string {
  return (
    "/config/" +
    path
      .split("/")
      .map((part) => {
        if (!part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part))
          throw new Error("Invalid configuration path.");
        return encodeURIComponent(part);
      })
      .join("/")
  );
}

export function readPath(value: object, path: string, fallback: unknown = undefined): unknown {
  return (
    path
      .split("/")
      .reduce<unknown>((v, k) => (v as Record<string, unknown> | null | undefined)?.[k], value) ??
    fallback
  );
}

/** No value at a config path: the server answers 404 there. Distinct from a stored `null`. */
export const absent: unique symbol = Symbol("absent");

/**
 * The value at `path` exactly as stored, the baseline a config write compares against: `null`
 * stays `null`, and a key the file lacks, or a parent that is not an object, is `absent`.
 */
export function storedValue(value: object, path: string): unknown {
  let v: unknown = value;
  for (const k of path.split("/")) {
    if (!v || typeof v !== "object" || !Object.hasOwn(v, k)) return absent;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}
