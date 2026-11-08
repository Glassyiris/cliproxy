import { equal } from "../compare.ts";
import { ConfigChangedError } from "./config.ts";

export function removeConfirmed<T>(list: T[], index: number, confirmed: unknown, path: string) {
  if (index < 0 || index >= list.length || !equal(list[index], confirmed))
    throw new ConfigChangedError(path);
  return list.filter((_, i) => i !== index);
}
