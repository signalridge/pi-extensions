// Deliberately pure: a compiled fixture must never load Pi or user credentials.
import { assertOwnedBashRuntime } from "../src/local-runtime.ts";

try {
  assertOwnedBashRuntime();
  throw new Error("Compiled runtime was incorrectly accepted");
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("standalone Node")) throw error;
  process.stdout.write("COMPILED_RUNTIME_REFUSED_BEFORE_DISPATCH\n");
}
