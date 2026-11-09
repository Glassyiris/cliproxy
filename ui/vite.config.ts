import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import stylex from "@stylexjs/unplugin/vite";
import { noticesPlugin } from "./tools/notices-plugin.ts";

// Development only: point the proxy at another backend with CPA_BACKEND=http://127.0.0.1:8318.
const backend = process.env.CPA_BACKEND || "http://127.0.0.1:8317";

export default defineConfig({
  base: "./",
  // The app's StyleX rules go in layer `app`, between Astryx's component atomics and the theme
  // (src/themes/layers.css). The header names the Astryx layers too, so the order holds when
  // this stylesheet loads first, as it does in dev.
  plugins: [
    // Every browser the dashboard supports reads woff2, and the server embeds every emitted
    // file, so Fontsource's .woff fallbacks would only add bytes to the binary.
    {
      name: "figtree-woff2-only",
      enforce: "pre",
      transform(code, id) {
        if (id.includes("/@fontsource/figtree/") && id.endsWith(".css"))
          return code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, "");
      },
    },
    stylex({
      useCSSLayers: { before: ["reset", "astryx-base"], prefix: "app", after: ["astryx-theme"] },
    }),
    react(),
    // Inert unless COOK_ROUTER_NOTICES_OUT is set (tools/third-party-notices.py).
    noticesPlugin(),
  ],
  // cors: false lets OPTIONS capability probes reach the backend instead of Vite.
  server: {
    port: 5173,
    cors: false,
    proxy: { "/v8": backend, "/v1": backend, "/healthz": backend },
  },
  // ui/dist is committed: the Rust binary embeds it at compile time (crates/cpa-server/build.rs).
  build: { target: "es2022", sourcemap: false, outDir: "dist" },
});
