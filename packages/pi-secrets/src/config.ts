import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compilePattern, type LiteralSecret, type SecretPattern, safeLabel } from "./patterns.js";
import { generatePlaceholderKey, MIN_SECRET_LENGTH } from "./placeholder.js";

export const CONFIG_FILE_NAME = "pi-secrets.json";
export const KEY_FILE_NAME = "pi-secrets.key";

export type ConfigScope = "user" | "project";
export type ConfigFileStatus = "loaded" | "missing" | "invalid" | "untrusted";

export interface ConfigFileReport {
  readonly scope: ConfigScope;
  readonly status: ConfigFileStatus;
  readonly values: number;
  readonly patterns: number;
}

export interface SecretsConfig {
  readonly literals: LiteralSecret[];
  readonly patterns: SecretPattern[];
  readonly files: ConfigFileReport[];
  /** Messages name the file scope and entry index, never a configured value. */
  readonly warnings: string[];
}

export interface ConfigFileInput {
  readonly scope: ConfigScope;
  readonly path: string;
  /** Project files are read only for trusted projects. */
  readonly trusted: boolean;
}

const ENTRY_KEYS = new Set(["name", "value", "pattern", "flags"]);
const PATTERN_FLAGS = /^[imsuv]*$/;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseEntry(
  entry: unknown,
  where: string,
  warnings: string[],
):
  | {
      literal?: Omit<LiteralSecret, "source">;
      pattern?: Omit<SecretPattern, "source">;
    }
  | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    warnings.push(`${where}: an entry must be an object`);
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ENTRY_KEYS.has(key)) warnings.push(`${where}: unknown key "${key}" ignored`);
  }
  const { name, value, pattern, flags } = record;
  if (name !== undefined && typeof name !== "string") {
    warnings.push(`${where}: "name" must be a string`);
    return undefined;
  }
  if ((value === undefined) === (pattern === undefined)) {
    warnings.push(`${where}: set exactly one of "value" or "pattern"`);
    return undefined;
  }
  if (value !== undefined) {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) {
      warnings.push(`${where}: "value" must be a string of at least ${MIN_SECRET_LENGTH} characters`);
      return undefined;
    }
    if (flags !== undefined) warnings.push(`${where}: "flags" applies only to "pattern" and was ignored`);
    return { literal: { value, label: safeLabel(name, value) } };
  }
  if (typeof pattern !== "string" || pattern.length === 0) {
    warnings.push(`${where}: "pattern" must be a non-empty string`);
    return undefined;
  }
  if (flags !== undefined && (typeof flags !== "string" || !PATTERN_FLAGS.test(flags))) {
    warnings.push(`${where}: "flags" may contain only i, m, s, u and v`);
    return undefined;
  }
  try {
    return {
      pattern: {
        label: safeLabel(name),
        regex: compilePattern(pattern, flags),
      },
    };
  } catch {
    warnings.push(`${where}: "pattern" is not a valid regular expression`);
    return undefined;
  }
}

function loadFile(input: ConfigFileInput, read: (path: string) => string, config: SecretsConfig): ConfigFileReport {
  const report = (status: ConfigFileStatus, values = 0, patterns = 0): ConfigFileReport => ({
    scope: input.scope,
    status,
    values,
    patterns,
  });
  if (!input.trusted) return report("untrusted");
  let text: string;
  try {
    text = read(input.path);
  } catch (error) {
    if (isMissing(error)) return report("missing");
    config.warnings.push(`${input.scope} ${CONFIG_FILE_NAME}: could not be read`);
    return report("invalid");
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    config.warnings.push(`${input.scope} ${CONFIG_FILE_NAME}: invalid JSON`);
    return report("invalid");
  }
  const entries =
    document !== null && typeof document === "object" && !Array.isArray(document)
      ? (document as Record<string, unknown>).secrets
      : undefined;
  if (!Array.isArray(entries)) {
    config.warnings.push(`${input.scope} ${CONFIG_FILE_NAME}: expected an object with a "secrets" array`);
    return report("invalid");
  }
  let values = 0;
  let patterns = 0;
  entries.forEach((entry, index) => {
    const parsed = parseEntry(entry, `${input.scope} ${CONFIG_FILE_NAME} secrets[${index}]`, config.warnings);
    if (parsed?.literal) {
      config.literals.push({ ...parsed.literal, source: "config" });
      values += 1;
    }
    if (parsed?.pattern) {
      config.patterns.push({ ...parsed.pattern, source: "configPattern" });
      patterns += 1;
    }
  });
  return report("loaded", values, patterns);
}

/** Load the user file, then the project file when the project is trusted. Both apply. */
export function loadSecretsConfig(
  inputs: readonly ConfigFileInput[],
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): SecretsConfig {
  const config: SecretsConfig = {
    literals: [],
    patterns: [],
    files: [],
    warnings: [],
  };
  for (const input of inputs) config.files.push(loadFile(input, read, config));
  return config;
}

export interface PlaceholderKey {
  readonly key: string;
  /** False when the key lives only in this process; placeholders then change across restarts. */
  readonly persistent: boolean;
  readonly problem?: string;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function readKey(path: string): string {
  const text = readFileSync(path, "utf8").trim();
  if (!KEY_PATTERN.test(text)) throw new Error("invalid key file");
  return text;
}

/**
 * Load the per-installation placeholder key, creating it (mode 0600) when
 * absent. The key keeps placeholders stable across sessions and stops a
 * transcript reader from hashing candidate secrets to match a placeholder.
 * An unreadable or invalid file is left untouched and an ephemeral key is used.
 */
export function loadPlaceholderKey(path: string): PlaceholderKey {
  try {
    return { key: readKey(path), persistent: true };
  } catch (error) {
    if (!isMissing(error))
      return {
        key: generatePlaceholderKey(),
        persistent: false,
        problem: "unreadable or invalid",
      };
  }
  const key = generatePlaceholderKey();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, key, { flag: "wx", mode: 0o600 });
    return { key, persistent: true };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      // Another process created it first; use its key when it is complete.
      try {
        return { key: readKey(path), persistent: true };
      } catch {
        // Fall through to an ephemeral key.
      }
    }
    return { key, persistent: false, problem: "could not be created" };
  }
}
