import type { RequestBucket } from "./credentials.ts";
import { request } from "./client.ts";
import { routes } from "./routes.ts";

/** Per provider, then per "<base_url>|<api_key>" (the raw key), lifetime and recent counts. */
export type ApiKeyUsage = Record<string, Record<string, { success: number; failed: number; recent_requests: RequestBucket[] }>>;

export const apiKeyUsage = (signal?: AbortSignal) => request<ApiKeyUsage>(routes.apiKeyUsage, { signal });

/** One finished request. Records also carry the client key, client IP and headers; the server sends more fields. */
export type UsageRecord = {
  timestamp: string;
  latency_ms: number;
  ttft_ms: number;
  failed: boolean;
  fail: { status_code: number; body: string };
  provider: string;
  model: string;
  alias: string;
  auth_index: string;
  request_id: string;
  tokens: { input_tokens: number; output_tokens: number; reasoning_tokens: number; cached_tokens: number; total_tokens: number };
};

/**
 * Take up to `count` records off the server's queue. Reading removes them for every reader, so
 * this runs only while the user has the live view on. Records that are not JSON arrive as strings.
 */
export const drainUsageQueue = (count: number, signal?: AbortSignal) =>
  request<(UsageRecord | string)[]>(routes.drainUsageQueue, { query: { count }, signal });
