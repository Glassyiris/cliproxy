// Flat config. Every rule is an error. tools/lint.mjs runs it and accepts only the per-rule
// counts recorded in tools/lint-ratchet.json (legacy debt); any other finding fails.
import { existsSync, readdirSync } from "node:fs";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const featuresDir = new URL("./src/features", import.meta.url);
const features = existsSync(featuresDir)
  ? readdirSync(featuresDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : [];

const featureOf = (name) => ({
  group: [`**/features/${name}/**`, `**/features/${name}`, `../${name}`, `../${name}/**`],
});
const deepFeature = {
  group: ["**/features/*/**"],
  message: "A feature is imported only through its index.ts.",
};
const noFeatures = {
  group: ["**/features", "**/features/**"],
  message: "Shared code moves up: lib/ and components/ never import a feature.",
};

const sourceFiles = ["src/**/*.{ts,tsx}", "vite.config.ts"];

export default defineConfig(
  { ignores: ["dist/**", "dist-next/**", "node_modules/**", "public/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  {
    files: sourceFiles,
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          minimumDescriptionLength: 10,
        },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "max-lines": ["error", { max: 600 }],
      "max-lines-per-function": ["error", { max: 80 }],
      complexity: ["error", 15],
      // Network access has one home, src/lib/api (relaxed below).
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Call src/lib/api instead of fetch." },
        { name: "XMLHttpRequest", message: "Call src/lib/api instead of XMLHttpRequest." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[property.name='fetch'][object.name=/^(window|globalThis|self)$/]",
          message: "Call src/lib/api instead of fetch.",
        },
      ],
      // Everywhere outside features/ and lib/ and components/: deep feature imports only.
      "no-restricted-imports": ["error", { patterns: [deepFeature] }],
    },
  },
  {
    files: ["src/lib/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [noFeatures] }] },
  },
  ...features.map((name) => ({
    files: [`src/features/${name}/**/*.{ts,tsx}`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            deepFeature,
            ...features
              .filter((other) => other !== name)
              .map((other) => ({
                ...featureOf(other),
                message: "A feature never imports another feature; move shared code up.",
              })),
          ],
        },
      ],
    },
  })),
  {
    // node:test registers a top-level test by calling test(); awaiting that promise adds nothing.
    files: ["src/**/*.test.{ts,tsx}"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
  {
    files: ["src/lib/api/**/*.{ts,tsx}"],
    rules: { "no-restricted-globals": "off", "no-restricted-syntax": "off" },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.es2022 } },
    rules: {
      "max-lines": ["error", { max: 600 }],
      "max-lines-per-function": ["error", { max: 80 }],
      complexity: ["error", 15],
    },
  },
  {
    // The harness serialises functions into the page, where browser globals exist.
    files: ["tools/perf/**/*.mjs"],
    languageOptions: { globals: globals.browser },
  },
);
