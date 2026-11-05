import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as tui from "@earendil-works/pi-tui";
import type * as stamp from "../src/stamp.js";

/** Execute the actual rollback reader AND renderer, not a reimplementation.
 * These source objects are pinned, independent of the working tree and index.
 * Tests are repository-only (not shipped); the baseline Git objects are required.
 */
export function frozenBaseline(): Pick<typeof stamp, "isMessageStampData" | "createStampEntryRenderer"> {
  const modules = new Map<string, unknown>([["@earendil-works/pi-tui", tui]]);
  const directory = mkdtempSync(join(tmpdir(), "pi-stamp-frozen-"));
  try {
    for (const name of ["metadata", "format", "stamp"]) {
      const source = execFileSync(
        "git",
        ["show", `0d824d1685026871270bf92f662a8c7f7cdd8ac3:packages/pi-stamp/src/${name}.ts`],
        { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8" },
      );
      const input = join(directory, `${name}.ts`);
      const output = join(directory, `${name}.cjs`);
      writeFileSync(input, source);
      // TypeScript 7 no longer exports the JS compiler API. Use the repository's
      // Bun toolchain to transpile the unchanged source, keeping imports external.
      execFileSync("bun", ["build", input, "--target=node", "--format=cjs", "--external=*", `--outfile=${output}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const module = { exports: {} };
      const load = runInNewContext(`(function(require, module, exports) { ${readFileSync(output, "utf8")}\n})`, {
        process,
        Intl,
        Date,
      });
      load(
        (id: string) => {
          // Menus/settings are not used by the frozen reader/renderer.
          if (id === "./menu.js" || id === "./settings.js") return {};
          if (!modules.has(id)) throw new Error(`Unexpected frozen dependency: ${id}`);
          return modules.get(id);
        },
        module,
        module.exports,
      );
      modules.set(`./${name}.js`, module.exports);
    }
    return modules.get("./stamp.js") as ReturnType<typeof frozenBaseline>;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
