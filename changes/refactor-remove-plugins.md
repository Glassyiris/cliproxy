Removed

- cook-router no longer loads plugins. Native and RPC plugins, the plugin store, request interceptors, plugin model routers, schedulers and executors, plugin OAuth logins and plugin quota providers are gone. To extend cook-router, change its source and build it yourself.
- The `plugins:` config section is no longer accepted: a config file that still has one is rejected with the usual unknown-key error. Remove the section before upgrading.
- A database that stores plugin settings, current or only in its history, no longer opens: startup fails with `unknown stored resource kind "plugin"`. Start from a new data volume.
- The plugin management routes are gone and answer like any unknown path: `/v0/management/plugins`, `/v0/management/plugin-store`, `/v8/management/plugins` and their store, install, enable and quota routes, `/quota/providers`, `/quota/reset`, and the plugin routes under `/v0/resource/plugins/` and `/plugins/`. `POST /v0/management/quota/fetch` still runs the `quota_probe` of a credential.
- The admin API has no `plugin` resource kind: `/admin/v1/r/plugin` answers 404 `unknown_kind`.
- The credential list no longer reports `quota_plugin_id`. A stored credential whose type no built-in provider serves, such as one a plugin parsed, is kept but listed as `error`, unavailable, with the status message `unsupported credential type`; the server logs a warning when it appears or changes. Delete or replace such files.
- Responses no longer carry the `X-Cook-Support-Plugin` header, and CORS no longer exposes it.
- Command-line flags declared by plugins are gone; an unknown flag fails like any other.
- The dashboard no longer has a Plugins dialog, plugin quota resets or plugin logins.
