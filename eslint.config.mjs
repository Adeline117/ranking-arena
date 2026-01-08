import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Project overrides: keep lint useful, but don't block deploy on legacy patterns.
  {
    rules: {
      // This repo contains many pragmatic uses of `any` across UI + scripts.
      "@typescript-eslint/no-explicit-any": "off",

      // These rules are helpful, but currently too strict for the codebase patterns.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",

      // Next link rule is nice-to-have; we allow <a> in simple 404 pages.
      "@next/next/no-html-link-for-pages": "off",
      "@next/next/no-img-element": "off",

      // Prefer const is fine as warning (autofixable), not a deploy blocker.
      "prefer-const": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Tooling / docs - don't block app lint
    "scripts/**",
    "docs/**",
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
