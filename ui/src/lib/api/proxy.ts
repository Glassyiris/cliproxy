import { ApiError, base, ConnectionError } from "./client.ts";
import { ConfigChangedError, isUsableSecret } from "./config.ts";

/**
 * The model ids this proxy offers a client key, asked the way a tool asks. No upstream call.
 * A 401 means the key is not a client key. The 30 s timeout of management requests applies,
 * reading the body included, and ends as ConnectionError "timeout".
 */
export async function listClientModels(clientKey: string, signal?: AbortSignal): Promise<string[]> {
  if (!isUsableSecret(clientKey)) throw new ConfigChangedError("client-key");
  const route = { method: "GET", path: "/v1/models" } as const;
  const timeout = AbortSignal.timeout(30_000);
  try {
    const r = await fetch(`${base}${route.path}`, {
      headers: { Authorization: `Bearer ${clientKey}` },
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!r.ok) throw new ApiError(`HTTP ${r.status}`, r.status, "", route);
    const body: { data?: { id: string }[] } = await r.json();
    return (body.data ?? []).map((m) => String(m.id));
  } catch (e) {
    if (timeout.aborted && !signal?.aborted) throw new ConnectionError("timeout");
    throw e;
  }
}
