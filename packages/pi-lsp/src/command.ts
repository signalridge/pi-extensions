import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const WINDOWS_LAUNCHER_EXTENSIONS = [".exe", ".cmd", ".bat"];

export function commandExists(command: string, cwd = process.cwd(), pathValue = process.env.PATH ?? "") {
  return resolveCommandPath(command, cwd, process.platform, pathValue) !== undefined;
}

export function commandPathValue(env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform = process.platform) {
  return environmentValue(mergeEnvironment(env, platform), "PATH", platform) ?? "";
}

export function mergeEnvironment(
  overrides: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform = process.platform,
) {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (platform === "win32") {
      for (const existingKey of Object.keys(environment)) {
        if (existingKey.toLowerCase() === key.toLowerCase()) delete environment[existingKey];
      }
    }
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

export function environmentValue(
  environment: NodeJS.ProcessEnv | Record<string, string> | undefined,
  name: string,
  platform: NodeJS.Platform,
) {
  if (platform !== "win32") return environment?.[name];
  let value: string | undefined;
  for (const [key, candidate] of Object.entries(environment ?? {})) {
    if (key.toLowerCase() === name.toLowerCase()) value = candidate;
  }
  return value;
}

export function resolveCommandPath(
  command: string,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
  pathValue = process.env.PATH ?? "",
) {
  // npm installs an extensionless POSIX shim beside its Windows shim. Prefer the
  // Windows launcher, but never append a suffix to an explicitly runnable name.
  const extensions =
    platform === "win32" && !WINDOWS_LAUNCHER_EXTENSIONS.includes(path.extname(command).toLowerCase())
      ? [...WINDOWS_LAUNCHER_EXTENSIONS, ""]
      : [""];
  if (command.includes("/") || command.includes("\\")) {
    const commandPath = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return resolveRunnableFile(commandPath, extensions, platform);
  }

  for (const directory of pathValue.split(platform === "win32" ? ";" : ":")) {
    const resolved = resolveRunnableFile(path.resolve(cwd, directory || ".", command), extensions, platform);
    if (resolved) return resolved;
  }

  return undefined;
}

function resolveRunnableFile(filePath: string, extensions: string[], platform: NodeJS.Platform) {
  for (const extension of extensions) {
    const candidate = `${filePath}${extension}`;
    if (isRunnableFile(candidate, platform)) return candidate;
  }
  return undefined;
}

function isRunnableFile(filePath: string, platform: NodeJS.Platform) {
  if (!existsSync(filePath)) return false;
  try {
    if (!statSync(filePath).isFile()) return false;
    if (platform !== "win32") accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
