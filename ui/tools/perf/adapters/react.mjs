// UI adapter for the React dashboard (src/). Same shape as svelte.mjs; see that file for how the
// harness reads each field. Only built pages are listed: a page joins `pages` when its route does.
//
// Astryx AppShell renders the page area as <div role="main">, not <main>.

const pageReady =
  "(() => { const m = document.querySelector('[role=main]'); const h = m && m.querySelector('h1'); return !!h && h.textContent.trim().startsWith(ctx.title) && !m.querySelector('[aria-busy=\"true\"]') && !m.querySelector('.astryx-skeleton'); })()";

/** Account rows of the Accounts table: each has its selection checkbox (group rows do not). */
const rows = "[role=main] tbody tr:has(input[type=checkbox])";
const allRows = `[...document.querySelectorAll('${rows} input[type=checkbox]')]`;
const toolbar = '[role=main] [aria-label="Selected accounts"]';
const panel = '[role=group][aria-label^="Details of "]';

export default {
  id: "react",
  label: "React dashboard (ui/src, Astryx)",

  login: {
    key: "input[type=password]",
    // The sign-in Connect button is type="button"; Enter in the field submits through onEnter.
    submit: 'form button:has-text("Connect")',
    // Shown once the session is open.
    done: "[role=main] h1",
    // Shown when sign-in is refused.
    error: "form [role=alert]",
  },

  /** Hash route of a page, as the app reads it (src/app/routes.ts). */
  hash: (id) => `#${id}`,

  /** The built pages. `title` is the English heading each page renders. */
  pages: [
    { id: "overview", title: "Overview" },
    { id: "accounts", title: "Accounts" },
    { id: "clients", title: "Client keys" },
    { id: "models", title: "Models" },
    { id: "activity", title: "Usage" },
    { id: "settings", title: "Settings" },
  ],
  pageReady,

  /**
   * M1 "listed". Accounts virtualizes its table, so only the rows in view are in the DOM: the page
   * is listed when the table counts every account (aria-rowcount, accounts plus provider group
   * rows) and its first rows are painted. Overview shows no row per account; it is listed when
   * it is ready, which its skeletons hold back until the account list has arrived.
   */
  listed: {
    accounts: `(${pageReady}) && Number(document.querySelector('[role=main] table')?.getAttribute('aria-rowcount')) >= ctx.n && !!document.querySelector('${rows}')`,
    overview: pageReady,
  },

  /** Accounts in the Accounts table model, group rows included. */
  rowCount:
    "Number(document.querySelector('[role=main] table')?.getAttribute('aria-rowcount') ?? 0)",

  /**
   * M5 interactions on Accounts. With the rows virtualized, "every row" is every rendered row;
   * the selection toolbar and the panel are the page-wide signs that the state changed.
   */
  interactions: [
    {
      name: "select all",
      target: "[role=main] thead input[type=checkbox]",
      done: `(${allRows}).length > 0 && (${allRows}).every((c) => c.checked) && !!document.querySelector('${toolbar}')`,
    },
    {
      name: "deselect all",
      target: "[role=main] thead input[type=checkbox]",
      done: `(${allRows}).every((c) => !c.checked) && !document.querySelector('${toolbar}')`,
    },
    {
      name: "select one row",
      target: `${rows} input[type=checkbox]`,
      done: `(${allRows}).filter((c) => c.checked).length === 1`,
    },
    {
      name: "unselect one row",
      target: `${rows} input[type=checkbox]`,
      done: `(${allRows}).every((c) => !c.checked)`,
    },
    {
      name: "expand row",
      target: `${rows} td:nth-child(2)`,
      done: `!!document.querySelector('${panel}')`,
    },
    {
      name: "collapse row",
      target: `${rows} td:nth-child(2)`,
      done: `!document.querySelector('${panel}')`,
    },
  ],

  /**
   * A failed /v8 request the UI provokes on purpose is not a coverage gap: the capability probes
   * of src/lib/api/probes.ts send an empty JSON body, a GET without its required parameter, or
   * count=0, which a real route rejects with 400 before any side effect.
   */
  isExpectedProbe: ({ method, url, status, postData }) =>
    status === 400 &&
    (method === "GET"
      ? /[?&]count=0\b/.test(url) || url === "/v8/management/oauth/auth-url"
      : postData === "{}" || !postData),
};
