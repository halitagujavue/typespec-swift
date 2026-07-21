import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000, // swift build is slow
    hookTimeout: 120_000,
  },
});
