import { ApiError, base } from "./client.ts";

/**
 * The model ids this proxy offers a client key, asked the way a tool asks. No upstream call.
 * A 401 means the key is not a client key.
 */
export async function listClientModels(clientKey: string, signal?: AbortSignal): Promise<string[]> {
  const route = { method: "GET", path: "/v1/models" } as const;
  const r = await fetch(`${base}${route.path}`, {
    headers: { Authorization: `Bearer ${clientKey}` },
    cache: "no-store",
    signal,
  });
  if (!r.ok) throw new ApiError(`HTTP ${r.status}`, r.status, "", route);
  const body: { data?: { id: string }[] } = await r.json();
  return (body.data ?? []).map((m) => String(m.id));
}
