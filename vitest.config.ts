import { defineConfig } from "vitest/config";

// Each test starts workerd through Miniflare, which takes seconds on a cold start.
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
