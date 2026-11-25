import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    // Node env by default (DB/route tests); DOM tests opt in per file via
    // the `@vitest-environment jsdom` docblock (Vitest 4 removed
    // environmentMatchGlobs) — tests/agent-panel-ui.test.tsx et al.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    // Pin a non-UTC zone so local-calendar assertions are meaningful on
    // CI (Ubuntu defaults to UTC): Berlin local midnight is the previous
    // UTC day.
    env: { TZ: "Europe/Berlin" },
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
})
