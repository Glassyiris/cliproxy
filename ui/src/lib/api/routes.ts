// Every Management API route the dashboard calls, in the router's path syntax. Admin paths
// start with /admin/v1; other paths are relative to /v8/management. tools/check-api.mjs compares
// this table with the Rust router, so it must stay a plain object literal with no imports.
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Route = { readonly method: Method; readonly path: string };

export const routes = {
  signIn: { method: "POST", path: "/session" },
  checkSession: { method: "GET", path: "/session" },
  signOut: { method: "DELETE", path: "/session" },

  readConfig: { method: "GET", path: "/admin/v1/effective/config" },
  applyConfig: { method: "POST", path: "/admin/v1/apply" },
  listClientKeys: { method: "GET", path: "/admin/v1/r/client-key" },
  exportConfig: { method: "GET", path: "/admin/v1/export" },
  readResource: { method: "GET", path: "/admin/v1/r/{kind}/{id}" },

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
  submitOAuthCallback: { method: "POST", path: "/oauth/callback" },
} as const satisfies Record<string, Route>;

// Routes outside /v8/management that need no key, relative to the page's base. tools/check-api.mjs
// finds each in crates/ck-server/src/lib.rs.
export const publicRoutes = {
  healthz: { method: "GET", path: "/healthz" },
} as const satisfies Record<string, Route>;
