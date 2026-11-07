import { request } from "./client.ts";
import { routes } from "./routes.ts";

/** A request the server sends with a credential's token; `$TOKEN$` in a header or `data` is replaced. */
export type ProviderCall = {
  authIndex: string;
  method: string;
  url: string;
  header?: Record<string, string>;
  data?: string;
};

/** The provider's answer. HTTP 200 even when the provider failed: check `status_code`. */
export type ProviderAnswer = { status_code: number; header: Record<string, string[]>; body: string };

export const callProvider = (call: ProviderCall) => request<ProviderAnswer>(routes.callProvider, { body: call });
