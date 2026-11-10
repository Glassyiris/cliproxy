import { request } from "./client.ts";
import {
  applyResourceOperations,
  ConfigChangedError,
  isUsableSecret,
  revealResource,
} from "./config.ts";
import { routes } from "./routes.ts";

export type ClientKey = {
  id: string;
  ord: number;
  rev: number;
  spec: { key: string };
};

export const listClientKeys = (signal?: AbortSignal) =>
  request<{ items: ClientKey[] }>(routes.listClientKeys, { signal });

export function createClientKey(key: string) {
  if (!isUsableSecret(key)) throw new ConfigChangedError("client-key");
  return applyResourceOperations([
    { op: "put", kind: "client-key", id: crypto.randomUUID(), spec: { key }, if_absent: true },
  ]);
}

export const deleteClientKey = (resource: ClientKey) =>
  applyResourceOperations([
    { op: "delete", kind: "client-key", id: resource.id, if_rev: resource.rev },
  ]);

export async function revealClientKey(id: string): Promise<string> {
  const resource = await revealResource("client-key", id);
  const spec = resource.spec;
  const key = spec && typeof spec === "object" && "key" in spec ? spec.key : undefined;
  if (!isUsableSecret(key)) throw new ConfigChangedError(`client-key/${id}`);
  return key;
}
