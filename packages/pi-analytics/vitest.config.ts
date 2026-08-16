import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 0,
    setupFiles: ["./test/vitest.setup.ts"],
    testTimeout: 0,
  },
});
