import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    // Node env by default (DB/route tests); DOM tests opt in per file via
    // the `@vitest-environment jsdom` docblock (Vitest 4 removed
    // environmentMatchGlobs) — tests/agent-panel-ui.test.tsx et al.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
})
