/**
 * saved-workflows.ts — persisted user workflows (A7).
 *
 * Layout: `~/.pi/workflows/projects/<basename>-<sha256(cwd)[0:12]>/saved/*.js`
 * with a `settings.json` next to the run directory. Writes are atomic
 * (temp file + rename) with a `.bak` backup kept before replacement. Names are
 * validated against a bounded identifier pattern so a saved name can never
 * escape the saved directory or collide with command registration.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Names a saved workflow; the same pattern feeds slash-command registration. */
const SAVED_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function isValidSavedName(name: string): boolean {
  return SAVED_NAME_PATTERN.test(name);
}

function projectDir(cwd: string): string {
  const encoded = basename(resolve(cwd)) || "root";
  const digest = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12);
  return join(getAgentDir(), "workflows", "projects", `${encoded}-${digest}`);
}

function savedDir(cwd: string): string {
  return join(projectDir(cwd), "saved");
}

function savedPath(name: string, cwd: string): string {
  return join(savedDir(cwd), `${name}.js`);
}

function userSavedDir(): string {
  return join(getAgentDir(), "workflows", "saved");
}

function userSavedPath(name: string): string {
  return join(userSavedDir(), `${name}.js`);
}

/** Atomic write with backup: temp file + rename, keeping a .bak of the prior content. */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  if (existsSync(path)) {
    try {
      renameSync(path, `${path}.bak`);
    } catch {
      // Best-effort backup; the rename below still replaces the target.
    }
  }
  writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
  try {
    rmSync(`${path}.bak`, { force: true });
  } catch {
    // best-effort
  }
}

/** Save a workflow script under `name`. Throws on invalid names. */
export function saveWorkflow(name: string, script: string, cwd: string = process.cwd()): void {
  if (!isValidSavedName(name)) {
    throw new Error(
      `Invalid workflow name "${name}": use letters, digits, and ._- only, at most 64 characters, no leading separator.`,
    );
  }
  atomicWrite(savedPath(name, cwd), script);
}

/** Load a saved workflow script by name; undefined when absent or invalid. */
export function loadSavedWorkflow(name: string, cwd: string = process.cwd()): string | undefined {
  if (!isValidSavedName(name)) return undefined;
  for (const path of [savedPath(name, cwd), userSavedPath(name)]) {
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf8");
      if (content.length > 0 && content.length <= 200_000) return content;
    } catch {
      // Project errors do not hide a valid user-scope fallback.
    }
  }
  return undefined;
}

/** List saved workflow names (bounded). */
export function listSavedWorkflows(cwd: string = process.cwd()): string[] {
  const names = new Set<string>();
  for (const dir of [savedDir(cwd), userSavedDir()]) {
    if (!existsSync(dir)) continue;
    try {
      for (const file of readdirSync(dir)) {
        const name = file.endsWith(".js") ? basename(file, ".js") : "";
        if (isValidSavedName(name)) names.add(name);
      }
    } catch {
      // An unreadable scope is simply unavailable; the other scope still works.
    }
  }
  return [...names].sort();
}

/** Remove a saved workflow; returns false when it did not exist. */
export function removeSavedWorkflow(name: string, cwd: string = process.cwd()): boolean {
  if (!isValidSavedName(name)) return false;
  let removed = false;
  for (const path of [savedPath(name, cwd), userSavedPath(name)]) {
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { force: true });
      removed = true;
    } catch {
      // Keep trying the other scope; report whether anything was removed.
    }
  }
  return removed;
}
