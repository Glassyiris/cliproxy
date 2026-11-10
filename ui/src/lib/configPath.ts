/** Slash-separated keys in the effective config, passed as JSON rather than URL segments. */
export function configPath(path: string): string {
  for (const part of path.split("/")) {
    if (!part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part))
      throw new Error("Invalid configuration path.");
  }
  return path;
}

export function readPath(value: object, path: string, fallback: unknown = undefined): unknown {
  return (
    path
      .split("/")
      .reduce<unknown>((v, k) => (v as Record<string, unknown> | null | undefined)?.[k], value) ??
    fallback
  );
}

/** No value at a config path. Distinct from a stored `null` in a read snapshot. */
export const absent: unique symbol = Symbol("absent");

/**
 * The value at `path` in the effective config, the baseline a config write compares against:
 * `null` stays `null`, and a missing key, or a parent that is not an object, is `absent`.
 */
export function storedValue(value: object, path: string): unknown {
  let v: unknown = value;
  for (const k of path.split("/")) {
    if (!v || typeof v !== "object" || !Object.hasOwn(v, k)) return absent;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}
