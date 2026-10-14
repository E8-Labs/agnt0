import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: "forks",
    // The preview page imports its stylesheet with `?raw`; let vitest return the real text.
    css: true,
  },
});
