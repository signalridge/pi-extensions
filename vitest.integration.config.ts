import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "scripts/editor-composition.test.ts",
      "scripts/status-navigation.test.ts",
      "scripts/goal-compaction-composition.test.ts",
      "scripts/goal-rules-composition.test.ts",
      "scripts/secrets-side-requests.test.ts",
    ],
    setupFiles: ["packages/pi-input-history/test/vitest.setup.ts"],
  },
});
