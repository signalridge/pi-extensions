import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Match host tool path spelling without importing private host modules. */
export function resolveToolPath(input: string, cwd: string): string {
  let value = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  if (process.platform === "win32" && !value.startsWith("//") && !value.includes("\\")) {
    value = value.replace(
      /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
      (_match, drive: string, rest: string | undefined) =>
        `${drive.toUpperCase()}:\\${rest?.replaceAll("/", "\\") ?? ""}`,
    );
  }
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")))
    value = join(homedir(), value.slice(2));
  if (value.startsWith("file://")) value = fileURLToPath(value);
  return resolve(cwd, value);
}
