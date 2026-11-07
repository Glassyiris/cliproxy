import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import stylex from "@stylexjs/unplugin/vite";

// Development only: point the proxy at another backend with CPA_BACKEND=http://127.0.0.1:8318.
const backend = process.env.CPA_BACKEND || "http://127.0.0.1:8317";

export default defineConfig({
  base: "./",
  // The app's StyleX rules go in layer `app`, between Astryx's component atomics and the theme
  // (src/themes/layers.css). The header names the Astryx layers too, so the order holds when
  // this stylesheet loads first, as it does in dev.
  plugins: [
    stylex({
      useCSSLayers: { before: ["reset", "astryx-base"], prefix: "app", after: ["astryx-theme"] },
    }),
    react(),
  ],
  // cors: false lets OPTIONS capability probes reach the backend instead of Vite.
  server: { port: 5173, cors: false, proxy: { "/v8": backend, "/healthz": backend } },
  // ui/dist is the embedded Svelte build until the final phase; the React build goes beside it.
  build: { target: "es2022", sourcemap: false, outDir: "dist-next" },
});
