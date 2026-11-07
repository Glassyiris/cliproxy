import type { Data } from "./json.ts";

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

export function readPath(value: Data, path: string, fallback: any = undefined): any {
  return path.split("/").reduce((v, k) => v?.[k], value) ?? fallback;
}
