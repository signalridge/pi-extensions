import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    hookTimeout: 0,
    setupFiles: ["./test/vitest.setup.ts"],
    testTimeout: 0,
  },
});
