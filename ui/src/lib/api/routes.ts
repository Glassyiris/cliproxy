// Every Management API route the dashboard calls, relative to /v8/management, in the
// router's path syntax. tools/check-api.mjs compares this table with the Rust router,
// so it must stay a plain object literal with no imports.
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Route = { readonly method: Method; readonly path: string };

export const routes = {
  readConfig: { method: "GET", path: "/config" },
  readConfigYaml: { method: "GET", path: "/config.yaml" },
  writeConfigYaml: { method: "PUT", path: "/config.yaml" },
  readConfigValue: { method: "GET", path: "/config/{*path}" },
  writeConfigValue: { method: "PUT", path: "/config/{*path}" },

  listCredentials: { method: "GET", path: "/credentials" },
  uploadCredentials: { method: "POST", path: "/credentials" },
  deleteCredentials: { method: "DELETE", path: "/credentials" },
  listCredentialModels: { method: "GET", path: "/credentials/models" },
  downloadCredential: { method: "GET", path: "/credentials/download" },
  setCredentialStatus: { method: "PATCH", path: "/credentials/status" },
  setCredentialFields: { method: "PATCH", path: "/credentials/fields" },
  refreshCredentials: { method: "POST", path: "/credentials/refresh" },

  listModelDefinitions: { method: "GET", path: "/routing/model-definitions/{channel}" },
  resetCooldown: { method: "POST", path: "/routing/cooldown/reset" },

  callProvider: { method: "POST", path: "/requests/api-call" },

  latestVersion: { method: "GET", path: "/server/latest-version" },

  apiKeyUsage: { method: "GET", path: "/observability/usage/api-keys" },
  drainUsageQueue: { method: "GET", path: "/observability/usage/queue" },
  readLogs: { method: "GET", path: "/observability/logs" },
  clearLogs: { method: "DELETE", path: "/observability/logs" },
  listErrorLogs: { method: "GET", path: "/observability/logs/errors" },
  downloadErrorLog: { method: "GET", path: "/observability/logs/errors/{name}" },
  readRequestLog: { method: "GET", path: "/observability/logs/requests/{id}" },

  startOAuth: { method: "GET", path: "/oauth/auth-url" },
  oauthStatus: { method: "GET", path: "/oauth/status" },
  cancelOAuth: { method: "DELETE", path: "/oauth/session" },
  importOAuth: { method: "POST", path: "/oauth/import" },
  bindSiwc: { method: "POST", path: "/oauth/siwc/bind" },
  submitOAuthCallback: { method: "POST", path: "/oauth/callback" },

  listPlugins: { method: "GET", path: "/plugins" },
  deletePlugin: { method: "DELETE", path: "/plugins/{id}" },
  listPluginStore: { method: "GET", path: "/plugins/store" },
  installPlugin: { method: "POST", path: "/plugins/store/{id}/install" },
  fetchPluginQuota: { method: "POST", path: "/plugins/{id}/quota" },
  resetPluginQuota: { method: "DELETE", path: "/plugins/{id}/quota" },
} as const satisfies Record<string, Route>;
