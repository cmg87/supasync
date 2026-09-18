import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { obsidian: new URL("./tests/support/obsidian.ts", import.meta.url).pathname } },
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: ["node_modules", "dist", "apps/obsidian/main.js"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: true,
  },
});
