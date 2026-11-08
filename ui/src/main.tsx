import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "./themes/layers.css";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { App } from "./app/App.tsx";
import { astryxMessages, initialLocale, initialPalette } from "./app/preferences.ts";
import { t } from "./lib/i18n.ts";
import { notify } from "./lib/notify.ts";
import { defaultPalette, defaultTheme, loadPalette } from "./themes/site/index.ts";

// A new build replaces the old one's chunks, and a tab opened before it gets the HTML page for
// them: the next lazy page or dialog fails to load. Reload once to pick up the new build; the
// stored time stops a loop when the chunk is missing for another reason.
window.addEventListener("vite:preloadError", (event) => {
  const key = "cliproxy.reloadedForBuild";
  try {
    const last = Number(sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  location.reload();
});

// A Chinese page starts with Astryx's Chinese strings, and a stored palette is in before the
// first render, so nothing is drawn first in English or in the default palette.
const wanted = initialPalette();
const [messages, loaded] = await Promise.all([
  astryxMessages(initialLocale()),
  loadPalette(wanted),
]);
const palette = loaded
  ? { name: wanted, theme: loaded }
  : { name: defaultPalette, theme: defaultTheme };

// flushSync commits the first render and its effects, so the toast bridge is listening before
// the failed-palette notice below.
flushSync(() =>
  createRoot(document.getElementById("app")!).render(
    <StrictMode>
      <App messages={messages} palette={palette} />
    </StrictMode>,
  ),
);
if (!loaded) notify("error", t("app.colors.failed"));
