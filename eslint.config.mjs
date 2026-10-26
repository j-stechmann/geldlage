import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored, copy-and-own ReUI sources (installed via the ReUI shadcn
    // registry, ADR-0035) — upstream's own react-compiler-era rules
    // (Date.now in render, setState-in-effect, refs during render) are
    // stricter against this config; owned files keep the repo rules.
    "components/reui/**",
  ]),
])

export default eslintConfig
