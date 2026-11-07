import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { App } from "./app/App.tsx";
import { astryxMessages, initialLocale, initialPalette } from "./app/preferences.ts";
import { t } from "./lib/i18n.ts";
import { notify } from "./lib/notify.ts";
import { defaultPalette, loadPalette, siteTheme } from "./themes/site/index.ts";

// A Chinese page starts with Astryx's Chinese strings, and a stored palette is in before the
// first render, so nothing is drawn first in English or in the default palette.
const wanted = initialPalette();
const [messages, loaded] = await Promise.all([
  astryxMessages(initialLocale()),
  loadPalette(wanted),
]);
const palette = loaded
  ? { name: wanted, theme: loaded }
  : { name: defaultPalette, theme: siteTheme };

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
