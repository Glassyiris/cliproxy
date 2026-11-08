import { request } from "./client.ts";
import { routes } from "./routes.ts";

export type LogPage = {
  lines: string[];
  "line-count": number;
  "latest-timestamp": number;
  "next-cursor": string;
  /** The cursor was stale; `lines` start over from the newest tail. */
  "cursor-reset"?: true;
};

/** The application log tail; pass the previous `next-cursor` to read only newer lines. */
export const readLogs = (options: { limit: number; cursor?: string }, signal?: AbortSignal) =>
  request<LogPage>(routes.readLogs, { query: options, signal });

export const clearLogs = () =>
  request<{ success: true; message: string; removed: number }>(routes.clearLogs);

export type ErrorLogFile = { name: string; size: number; modified: number };

export const listErrorLogs = (signal?: AbortSignal) =>
  request<{ files: ErrorLogFile[] }>(routes.listErrorLogs, { signal });

export const downloadErrorLog = (name: string, signal?: AbortSignal) =>
  request<Blob>(routes.downloadErrorLog, { params: { name }, signal, as: "blob" });

export const readRequestLog = (id: string, signal?: AbortSignal) =>
  request<string>(routes.readRequestLog, { params: { id }, signal, as: "text" });
