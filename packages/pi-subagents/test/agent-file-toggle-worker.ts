import { existsSync, writeFileSync } from "node:fs";
import { atomicCreateFile, atomicReplaceFile, removeFileIfUnchanged } from "../src/agent-file-toggle.js";

const [operation, path, expectedSource, content, readyPath, goPath] = process.argv.slice(2);

async function waitForGo(): Promise<void> {
  if (!readyPath || !goPath) return;
  writeFileSync(readyPath, `${process.pid}\n`, { mode: 0o600 });
  while (!existsSync(goPath)) await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

try {
  await waitForGo();
  if (operation === "replace") {
    await atomicReplaceFile(path, content, expectedSource);
  } else if (operation === "delete") {
    await removeFileIfUnchanged(path, expectedSource);
  } else if (operation === "create") {
    await atomicCreateFile(path, content);
  } else {
    throw new Error(`unknown operation: ${operation}`);
  }
  process.stdout.write("ok\n");
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
