import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("managed dispatch outside the Node VM bootstrap", () => {
  it.each(["slow", "busy", "fatal", "abort", "sync-abort"])(
    "drains %s without process-level errors",
    async (mode) => {
      const { stdout, stderr } = await execFileAsync(
        "node",
        [
          "--unhandled-rejections=strict",
          "--import",
          fixture("node-typescript.mjs"),
          fixture("managed-bootstrap.ts"),
          mode,
        ],
        { timeout: 20_000 },
      );
      expect(stderr).toBe("");
      expect(stdout).toContain(`PASS ${mode}`);
    },
    25_000,
  );
});
