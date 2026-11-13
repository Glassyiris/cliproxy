import { request } from "./client.ts";
import { routes } from "./routes.ts";

export type Cooldown = {
  scope: "credential" | "model";
  model_key?: string;
  reason:
    | "credential_quota"
    | "quota"
    | "unauthorized"
    | "payment_required"
    | "not_found"
    | "transient_error"
    | "unknown";
  retry_at: string;
  remaining_seconds: number;
  /** cooker only: the upstream's stated reset when the trusted cooldown bound cut it. */
  recover_at?: string;
  backoff_level?: number;
  http_status?: number;
};

/** One ten-minute traffic bucket; the server always sends 20, oldest first. */
export type RequestBucket = { time: string; success: number; failed: number };

/** Rate-limit headers and quota fields the server saw on real traffic, without asking the provider. */
type QuotaObservation = { observed_at?: string; signals: Record<string, string> };

export type Credential = {
  id: string;
  auth_index: string;
  name: string;
  type: string;
  provider: string;
  label: string;
  status: "active" | "disabled" | "error";
  status_message: string;
  disabled: boolean;
  unavailable: boolean;
  runtime_only: boolean;
  source: "memory" | "file";
  size: number;
  success: number;
  failed: number;
  recent_requests: RequestBucket[];
  quota: QuotaObservation;
  cooldowns: Cooldown[];
  model_quotas?: Record<string, QuotaObservation>;
  email?: string;
  project_id?: string;
  account_type?: "oauth" | "api_key";
  account?: string;
  created_at?: string;
  updated_at?: string;
  modtime?: string;
  last_refresh?: string;
  next_retry_after?: string;
  path?: string;
  /** Codex: the ChatGPT account the token belongs to, when the file records it. */
  account_id?: string;
  id_token?: { chatgpt_account_id?: string; plan_type?: string };
  priority?: number;
  note?: string;
  weight?: number;
  websockets?: boolean;
  request_retry?: number;
  siwc_bind_supported?: boolean;
  use_siwc?: boolean;
  siwc_bound?: boolean;
  siwc_expires_at?: string;
};

export type CredentialList = { observed_at: string; files: Credential[] };

export const listCredentials = (signal?: AbortSignal) =>
  request<CredentialList>(routes.listCredentials, { signal });

type Failed = { name: string; error: string }[];
/** One file answers `{status}` only; several add counts, and `partial` (HTTP 207) lists failures. */
type UploadResult = {
  status: "ok" | "partial";
  uploaded?: number;
  files?: string[];
  failed?: Failed;
};

export function uploadCredentials(files: File[]) {
  const form = new FormData();
  for (const file of files) form.append("file", file, file.name);
  return request<UploadResult>(routes.uploadCredentials, { body: form });
}

type DeleteResult = {
  status: "ok" | "partial";
  deleted?: number;
  files?: string[];
  failed?: Failed;
};

export const deleteCredentials = (names: string[]) =>
  request<DeleteResult>(routes.deleteCredentials, { body: { names } });

type CredentialModel = {
  id: string;
  display_name?: string;
  type?: string;
  owned_by?: string;
};

export const listCredentialModels = (name: string, signal?: AbortSignal) =>
  request<{ models: CredentialModel[] }>(routes.listCredentialModels, { query: { name }, signal });

/** The credential file as saved. */
export const downloadCredential = (name: string, signal?: AbortSignal) =>
  request<Blob>(routes.downloadCredential, { query: { name }, signal, as: "blob" });

type Target = { name: string; auth_index?: string };

type StatusResult = {
  status: "ok";
  disabled: boolean;
  via?: "config:excluded-models";
  excluded_pattern?: "*";
};

export const setCredentialStatus = (target: Target, disabled: boolean) =>
  request<StatusResult>(routes.setCredentialStatus, { body: { ...target, disabled } });

/**
 * Write fields into one credential's metadata. Every key is written as given, so the body must
 * not carry selectors such as auth_index; null deletes weight and request_retry.
 */
export type CredentialFields = {
  note?: string;
  priority?: number | null;
  weight?: number | null;
  request_retry?: number | null;
  [field: string]: unknown;
};

export const setCredentialFields = (name: string, fields: CredentialFields) =>
  request<{ status: "ok" }>(routes.setCredentialFields, { body: { ...fields, name } });

/** The refreshed credential. The server also returns its metadata, tokens included; leave it unread. */
type RefreshResult = {
  ok: true;
  auth: { id: string; provider: string; label: string; status: string; disabled: boolean };
};

export const refreshCredentials = (target: Target) =>
  request<RefreshResult>(routes.refreshCredentials, { body: target });
