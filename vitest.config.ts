import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Run files serially to share the local Mongo+Redis fixtures safely.
    fileParallelism: false,
    poolOptions: {
      threads: { singleThread: true },
    },
    setupFiles: ["./tests/setup.ts"],
  },
});
