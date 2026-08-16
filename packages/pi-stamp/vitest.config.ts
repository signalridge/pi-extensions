import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", testTimeout: 0, hookTimeout: 0, setupFiles: ["./test/vitest.setup.ts"] },
});
