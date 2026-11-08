import { base, request } from "./client.ts";
import { publicRoutes, routes } from "./routes.ts";

/** The newest release tag, such as "v1.2.3". 503 `update_check_disabled` when update checks are off. */
export const latestVersion = (signal?: AbortSignal) =>
  request<{ "latest-version": string }>(routes.latestVersion, { signal });

/**
 * Whether the server that served this page answers. Sent without the key, so it works before
 * sign-in; any failure, including a timeout, reads as not reachable.
 */
export async function healthz(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(5_000);
  try {
    const response = await fetch(`${base}${publicRoutes.healthz.path}`, {
      method: publicRoutes.healthz.method,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
      redirect: "error",
    });
    const body: unknown = response.ok ? await response.json() : null;
    return (body as { status?: unknown } | null)?.status === "ok";
  } catch (e) {
    if (signal?.aborted) throw e;
    return false;
  }
}
