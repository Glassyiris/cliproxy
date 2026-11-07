// UI adapter for the React dashboard (src/). Same shape as svelte.mjs; see that file for how the
// harness reads each field. Only built pages are listed: a page joins `pages` when its route does.
//
// Astryx AppShell renders the page area as <div role="main">, not <main>.

/** A page is ready when its heading is shown and no loading placeholder remains. */
const pageReady =
  "(() => { const m = document.querySelector('[role=main]'); const h = m && m.querySelector('h1'); return !!h && h.textContent.trim().startsWith(ctx.title) && !m.querySelector('[aria-busy=\"true\"]') && !m.querySelector('.astryx-skeleton'); })()";

export default {
  id: "react",
  label: "React dashboard (ui/src, Astryx)",

  login: {
    key: "input[type=password]",
    submit: "form button[type=submit]",
    // Shown once the session is open.
    done: "[role=main] h1",
    // Shown when sign-in is refused.
    error: "form [role=alert]",
  },

  /** Hash route of a page, as the app reads it (src/app/routes.ts). */
  hash: (id) => `#${id}`,

  /** The built pages. `title` is the English heading each page renders. */
  pages: [{ id: "system", title: "System" }],
  pageReady,

  // ponytail: Accounts and Overview do not exist yet, so M1 "listed", the row count and the M5
  // interactions have nothing to select. Fill them in when the Accounts page lands (P2).
  listed: {},
  rowCount: "0",
  interactions: [],

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
