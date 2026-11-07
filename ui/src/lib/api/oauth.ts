import { request } from "./client.ts";
import { routes } from "./routes.ts";

/** A browser sign-in, or a device flow (kimi, kimi-ai, meta, xai) with a code to enter. */
export type OAuthStart = {
  status: "ok";
  url: string;
  state: string;
  flow?: "device";
  user_code?: string;
  expires_in?: number;
};

/**
 * Start a provider sign-in. `forward` asks the server to catch the provider's redirect on its
 * local callback port (claude, codex, antigravity). Unknown providers answer 404 provider_not_found.
 */
export const startOAuth = (provider: string, forward: boolean, signal?: AbortSignal) =>
  request<OAuthStart>(routes.startOAuth, {
    query: { provider, is_webui: forward ? "true" : undefined },
    signal,
  });

/** HTTP 200 in every case; an unknown or expired state is `{status: "error"}`. */
export type OAuthStatus = { status: "ok" | "wait" } | { status: "error"; error: string };

export const oauthStatus = (state: string, signal?: AbortSignal) =>
  request<OAuthStatus>(routes.oauthStatus, { query: { state }, signal });

export const cancelOAuth = (state: string) =>
  request<{ status: "ok"; cancelled: boolean }>(routes.cancelOAuth, { query: { state } });

export type VertexImport = {
  status: "ok";
  "auth-file": string;
  project_id: string;
  email: string;
  location: string;
};

/** Import a Vertex service-account file. An empty location makes the server use us-central1. */
export function importVertex(file: File, location: string) {
  const form = new FormData();
  form.append("file", file);
  if (location) form.append("location", location);
  return request<VertexImport>(routes.importOAuth, { query: { provider: "vertex" }, body: form });
}

/** Start binding Sign in with ChatGPT to a file-backed Codex credential. */
export const bindSiwc = (name: string) =>
  request<{ status: "ok"; url: string; state: string; flow: "siwc_bind"; expires_in: number }>(
    routes.bindSiwc,
    {
      body: { name },
    },
  );

/** Finish a sign-in from the browser's final URL when the redirect page did not load. */
export const submitOAuthCallback = (provider: string, redirectUrl: string) =>
  request<{ status: "ok" }>(routes.submitOAuthCallback, {
    body: { provider, redirect_url: redirectUrl },
  });
