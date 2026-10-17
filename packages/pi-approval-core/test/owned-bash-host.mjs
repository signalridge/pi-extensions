import { registerHooks } from "node:module";

// Node's native type stripping does not remap source .js specifiers to .ts.
// Test-only source resolution; SDK modules retain their ordinary resolution.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && specifier.endsWith(".js"))
        return next(`${specifier.slice(0, -3)}.ts`, context);
      throw error;
    }
  },
});
const { createApprovalBashOperations, hashBytes } = await import("../src/index.ts");
const operations = createApprovalBashOperations({
  source: "host",
  toolCallId: "owned",
  inputHash: hashBytes("host"),
  request: async () => {},
  isCurrent: () => true,
});
process.on("message", () => process.exit(0));
await operations.exec(
  "printf '%s' $$ > shell.pid; sleep 30 & printf '%s' $! > descendant.pid; printf ready > ready; wait",
  process.argv[2],
  { onData() {} },
);
