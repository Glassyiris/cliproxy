import { request } from "./client.ts";
import { routes } from "./routes.ts";

type ConfigField = { name: string; type: string; enum_values: string[]; description: string };

/** Strings arrive HTML-escaped. */
export type Plugin = {
  id: string;
  path: string;
  configured: boolean;
  registered: boolean;
  enabled: boolean;
  effective_enabled: boolean;
  supports_oauth: boolean;
  oauth_provider: string;
  supports_quota: boolean;
  quota_provider?: string;
  logo: string;
  config_fields: ConfigField[];
  menus: { path: string; menu: string; description: string }[];
  /** Null until the plugin registers. */
  metadata: {
    name: string;
    version: string;
    author: string;
    github_repository: string;
    logo: string;
    config_fields: ConfigField[];
  } | null;
};

export type PluginList = { plugins_enabled: boolean; plugins_dir: string; plugins: Plugin[] };

export const listPlugins = (signal?: AbortSignal) =>
  request<PluginList>(routes.listPlugins, { signal });

export const deletePlugin = (id: string) =>
  request<{
    status: "deleted";
    id: string;
    path: string;
    file_deleted: boolean;
    configured_removed: boolean;
  }>(routes.deletePlugin, { params: { id } });

export type StorePlugin = {
  store_id: string;
  source_id: string;
  source_name: string;
  source_url: string;
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  repository: string;
  install_type: string;
  auth_required: boolean;
  auth_configured: boolean;
  logo?: string;
  homepage?: string;
  license?: string;
  tags?: string[];
  installed: boolean;
  installed_version: string;
  update_available: boolean;
};

export type PluginStore = {
  plugins_enabled: boolean;
  plugins_dir: string;
  sources: { id: string; name: string; url: string }[];
  source_errors?: { source_id: string; source_name: string; source_url: string; message: string }[];
  plugins: StorePlugin[];
};

export const listPluginStore = (signal?: AbortSignal) =>
  request<PluginStore>(routes.listPluginStore, { signal });

export const installPlugin = (id: string, source?: string) =>
  request<{
    status: "installed";
    id: string;
    version: string;
    path: string;
    source_id: string;
    restart_required: boolean;
  }>(routes.installPlugin, {
    params: { id },
    query: { source },
    body: {},
  });

/** A quota plugin's reading; plugins may use snake_case, which the readers also accept. */
export type PluginQuota = {
  subscription?: { plan?: string; tierName?: string; tierId?: string };
  groups?: {
    displayName?: string;
    buckets?: {
      window?: string;
      remainingFraction: number;
      resetTime?: string;
      description?: string;
    }[];
  }[];
};

export const fetchPluginQuota = (id: string, authIndex: string) =>
  request<PluginQuota>(routes.fetchPluginQuota, {
    params: { id },
    body: { auth_index: authIndex },
  });

/** Drop the quota the plugin stored for one credential. */
export const resetPluginQuota = (id: string, authIndex: string) =>
  request<{ status: "ok"; auth_index: string; message?: string }>(routes.resetPluginQuota, {
    params: { id },
    query: { auth_index: authIndex },
  });
