import { request } from "./client.ts";
import { routes } from "./routes.ts";

/** The newest release tag, such as "v1.2.3". 503 `update_check_disabled` when update checks are off. */
export const latestVersion = (signal?: AbortSignal) =>
  request<{ "latest-version": string }>(routes.latestVersion, { signal });
