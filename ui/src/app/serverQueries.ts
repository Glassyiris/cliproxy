// The server reads several pages share, under one key factory, so a page that writes one
// refreshes it for every other page, and a page switch shows the cached answer while it rereads.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readConfig, replaceConfigValue } from "../lib/api/config.ts";
import { listCredentials, type Credential, type CredentialList } from "../lib/api/credentials.ts";
import { apiKeyUsage } from "../lib/api/observability.ts";
import { listPlugins } from "../lib/api/plugins.ts";
import { reconcile } from "../lib/compare.ts";
import { absent, storedValue } from "../lib/configPath.ts";
import type { Action } from "./useAction.ts";

export const serverKeys = {
  config: ["server", "config"] as const,
  credentials: ["server", "credentials"] as const,
  plugins: ["server", "plugins"] as const,
  apiKeyUsage: ["server", "api-key-usage"] as const,
};

const POLL_MS = 10_000;

/**
 * Every 10 s while the tab is shown, paused while it is hidden (REQUIREMENTS). TanStack's focus
 * refetch listens to visibilitychange, so an answer older than one interval is reread as soon as
 * the tab is shown again.
 */
const polling = (poll = false) =>
  poll
    ? {
        refetchInterval: POLL_MS,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        staleTime: POLL_MS,
      }
    : {};

export const useConfig = () =>
  useQuery({ queryKey: serverKeys.config, queryFn: ({ signal }) => readConfig(signal) });

// One file can hold several accounts, so a row is its file and its auth index.
const credentialKey = (a: Credential) => `${a.name}\u0000${a.auth_index}`;

/** Unchanged accounts keep their objects across polls, so memoized rows skip rendering. */
export const useCredentials = ({ poll }: { poll?: boolean } = {}) =>
  useQuery({
    queryKey: serverKeys.credentials,
    queryFn: ({ signal }) => listCredentials(signal),
    structuralSharing: (old: unknown, next: unknown) => {
      const before = old as CredentialList | undefined;
      const after = next as CredentialList;
      return before
        ? { ...after, files: reconcile(before.files, after.files, credentialKey) }
        : after;
    },
    ...polling(poll),
  });

export const usePlugins = () =>
  useQuery({ queryKey: serverKeys.plugins, queryFn: ({ signal }) => listPlugins(signal) });

export const useApiKeyUsage = ({ poll }: { poll?: boolean } = {}) =>
  useQuery({
    queryKey: serverKeys.apiKeyUsage,
    queryFn: ({ signal }) => apiKeyUsage(signal),
    ...polling(poll),
  });

/**
 * Replace one config value through the page's action: reread and compare first, refuse when the
 * server copy changed (REQUIREMENTS intentional design), and reread the config either way, so a
 * refused write leaves the page showing the server copy. The compare baseline is the value at
 * `path` in the config this render shows, `null` and an absent key kept apart, so no page can
 * hand in a baseline that a read with a fallback has collapsed. `next` may be a function, run
 * inside the action, so a removal that finds its target gone fails as a refused write.
 */
export function useConfigWrite(action: Action) {
  const queryClient = useQueryClient();
  const config = useConfig().data;
  // Before the first read there is nothing shown to write over; pages offer no write then.
  return (path: string, next: unknown, success?: string) =>
    config
      ? action.run(async () => {
          try {
            await replaceConfigValue(
              path,
              storedValue(config, path),
              typeof next === "function" ? (next as () => unknown)() : next,
              absent,
            );
          } finally {
            await queryClient.invalidateQueries({ queryKey: serverKeys.config });
          }
        }, success)
      : Promise.resolve(false);
}
