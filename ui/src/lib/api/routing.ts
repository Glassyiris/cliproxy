import { request } from "./client.ts";
import { routes } from "./routes.ts";

export type ModelDefinition = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  type: string;
  display_name?: string;
  name?: string;
  version?: string;
  description?: string;
  context_length?: number;
  max_completion_tokens?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supported_parameters?: string[];
  supports_web_search?: boolean;
  thinking?: { min?: number; max?: number; zero_allowed?: boolean; dynamic_allowed?: boolean; levels?: string[] };
};

/** The model catalog of one channel (claude, codex, antigravity, kimi, xai, meta, vertex, aistudio). */
export const listModelDefinitions = (channel: string, signal?: AbortSignal) =>
  request<{ channel: string; models: ModelDefinition[] }>(routes.listModelDefinitions, { params: { channel }, signal });

/** Clear this server's local cooldown for one credential. Provider quota is not restored. */
export const resetCooldown = (authIndex: string) =>
  request<{ status: "ok"; auth_index: string; models: string[] }>(routes.resetCooldown, { body: { auth_index: authIndex } });
