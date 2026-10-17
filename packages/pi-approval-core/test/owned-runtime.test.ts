import * as childProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createApprovalBashOperations } from "../src/tools.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

it.each(["bun", "sea", "missing-probe", "unknown-probe"] as const)(
  "rejects unsupported %s runtime before approval or any subprocess",
  async (kind) => {
    const cwd = await mkdtemp(join(tmpdir(), "approval-runtime-"));
    const bun = Object.getOwnPropertyDescriptor(process.versions, "bun");
    const probe = Object.getOwnPropertyDescriptor(process, "getBuiltinModule");
    const getBuiltin = process.getBuiltinModule;
    try {
      if (kind === "bun") Object.defineProperty(process.versions, "bun", { value: "1.4.3", configurable: true });
      else
        Object.defineProperty(process, "getBuiltinModule", {
          configurable: true,
          value:
            kind === "missing-probe"
              ? undefined
              : (id: string) =>
                  id === "node:sea" ? { isSea: () => (kind === "sea" ? true : undefined) } : getBuiltin(id),
        });
      const request = vi.fn(async () => {});
      const onData = vi.fn();
      vi.mocked(childProcess.spawn).mockClear();
      const operations = createApprovalBashOperations({
        source: "runtime-test",
        toolCallId: "runtime-test",
        inputHash: "a".repeat(64),
        request,
        isCurrent: () => true,
      });
      // The simulated flags do not change this test process's known Node path.
      // The old implementation safely runs printf, proving the missing refusal.
      await expect(operations.exec("printf RUNTIME_MUST_NOT_RUN", cwd, { env: {}, onData })).rejects.toThrow(
        /standalone Node/i,
      );
      expect(request).not.toHaveBeenCalled();
      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(onData).not.toHaveBeenCalled();
    } finally {
      if (bun) Object.defineProperty(process.versions, "bun", bun);
      else Reflect.deleteProperty(process.versions, "bun");
      if (probe) Object.defineProperty(process, "getBuiltinModule", probe);
      else Reflect.deleteProperty(process, "getBuiltinModule");
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

it("an actual Bun-compiled pure fixture refuses the runtime without loading an agent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-compiled-runtime-"));
  try {
    const fixture = fileURLToPath(new URL("./owned-runtime-host.mjs", import.meta.url));
    const binary = join(cwd, "compiled-runtime-fixture");
    childProcess.execFileSync("bun", ["build", "--compile", fixture, "--outfile", binary], {
      cwd,
      timeout: 20_000,
      stdio: "pipe",
    });
    expect(childProcess.execFileSync(binary, [], { cwd, timeout: 5_000, encoding: "utf8" })).toBe(
      "COMPILED_RUNTIME_REFUSED_BEFORE_DISPATCH\n",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
