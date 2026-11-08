// UI adapter for the Svelte dashboard. Every selector the harness uses lives here.
//
// To measure another implementation, copy this file to adapters/<name>.mjs, change the selectors and
// expressions, and run with --ui <name>. The harness itself knows nothing about the markup.
//
// Expressions are JavaScript source strings evaluated in the page. They see `ctx`:
//   ctx.n      number of accounts the mock serves
//   ctx.title  the expected page heading

const pageReady =
  "(() => { const h = document.querySelector('main#main h1'); return !!h && h.textContent.trim().startsWith(ctx.title) && !document.querySelector('main#main [aria-busy=\"true\"]') && !document.querySelector('main#main .skel'); })()";

const rows = "ul.acct > li > .item";

export default {
  id: "svelte",
  label: "Svelte 5 dashboard (ui/)",

  login: {
    key: "input[type=password]",
    submit: "form button.primary",
    // Shown once the session is open.
    done: "nav.side",
    // Shown when sign-in is refused.
    error: "form .note.error",
  },

  /** Hash route of a page, as the app reads it. */
  hash: (id) => `#${id}`,

  /** The 13 pages. `title` is the heading each page renders. */
  pages: [
    { id: "overview", title: "Overview" },
    { id: "use", title: "Use with tools" },
    { id: "accounts", title: "Accounts" },
    { id: "providers", title: "Provider keys" },
    { id: "keys", title: "Client keys" },
    { id: "models", title: "Models" },
    { id: "payload", title: "Payload rules" },
    { id: "usage", title: "Usage" },
    { id: "logs", title: "Logs" },
    { id: "config", title: "Configuration" },
    { id: "plugins", title: "Plugins" },
    { id: "system", title: "System" },
    { id: "connect", title: "Connect an account" },
  ],
  pageReady,

  /** Pages whose "loaded" state means every account is listed (M1). */
  listed: {
    accounts: `(${pageReady}) && document.querySelectorAll('${rows}').length >= ctx.n`,
    overview: `(${pageReady}) && document.querySelectorAll('ul.creds a.item[href^="#accounts/"]').length >= ctx.n`,
  },

  /** Number of account rows on the Accounts page, for sanity checks. */
  rowCount: `document.querySelectorAll('${rows}').length`,

  /**
   * M5 interactions on Accounts. Each step clicks `target` once and waits until `done` holds, then
   * for the next frame to be produced. A pair (do, undo) runs `reps` times; each step is reported.
   */
  interactions: [
    {
      name: "select all",
      target: "ul.acct li.columns input[type=checkbox]",
      done: `document.querySelectorAll('${rows}.sel').length >= ctx.n`,
    },
    {
      name: "deselect all",
      target: "ul.acct li.columns input[type=checkbox]",
      done: `document.querySelectorAll('${rows}.sel').length === 0`,
    },
    {
      name: "select one row",
      target: `${rows} input[type=checkbox]`,
      done: `document.querySelectorAll('${rows}.sel').length === 1`,
    },
    {
      name: "unselect one row",
      target: `${rows} input[type=checkbox]`,
      done: `document.querySelectorAll('${rows}.sel').length === 0`,
    },
    {
      name: "expand row",
      target: `${rows} button.name`,
      done: "!!document.querySelector('ul.acct li.open .detail')",
    },
    {
      name: "collapse row",
      target: `${rows} button.name`,
      done: "!document.querySelector('ul.acct li.open .detail')",
    },
  ],

  /**
   * A failed /v8 request the UI provokes on purpose is not a coverage gap. The UI asks servers other
   * than Go whether a route exists with an empty JSON body, a GET without its required parameter, or
   * count=0, which a real route rejects with 400 before any side effect (src/store.svelte.ts probe()).
   */
  isExpectedProbe: ({ method, url, status, postData }) =>
    status === 400 &&
    (method === "GET" ? /[?&]count=0\b/.test(url) || url === "/v8/management/oauth/auth-url" : postData === "{}" || !postData),
};
