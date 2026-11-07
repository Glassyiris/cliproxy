import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { App } from "./app/App.tsx";
import { astryxMessages, initialLocale } from "./app/preferences.ts";

// A Chinese page starts with Astryx's Chinese strings, so no control shows English first.
const messages = await astryxMessages(initialLocale());

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App messages={messages} />
  </StrictMode>,
);
