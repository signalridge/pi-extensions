/** Do not execute a compiled application as though it were a JS interpreter.
 * This pure capability check never probes by launching process.execPath and
 * leaves edit/write factories usable on hosts whose bash runtime is refused. */
export function assertOwnedBashRuntime(): void {
  const unavailable = () => {
    throw new Error(
      "Reviewed local bash requires a POSIX standalone Node.js runtime with public SEA detection; Bun and compiled application runtimes are unsupported",
    );
  };
  if (process.platform === "win32" || process.versions.bun || typeof process.getBuiltinModule !== "function")
    unavailable();
  const probe: unknown = process.getBuiltinModule("node:sea");
  if (
    !probe ||
    typeof probe !== "object" ||
    !("isSea" in probe) ||
    typeof probe.isSea !== "function" ||
    probe.isSea() !== false
  )
    unavailable();
}
