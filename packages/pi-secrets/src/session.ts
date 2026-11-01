import { join } from "node:path";
import {
  CONFIG_FILE_NAME,
  KEY_FILE_NAME,
  loadPlaceholderKey,
  loadSecretsConfig,
  type PlaceholderKey,
  type SecretsConfig,
} from "./config.js";
import {
  builtinPatterns,
  collectEnvironmentSecrets,
  type LiteralSecret,
  type SecretSource,
  SOURCE_ORDER,
} from "./patterns.js";
import { SecretRegistry } from "./registry.js";
import { mapMessages, mapStringsInPlace } from "./transform.js";

export interface SecretsSessionInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly agentDir: string;
  /** Project configuration directory, e.g. `<cwd>/.pi`. */
  readonly projectConfigDir: string;
  readonly projectTrusted: boolean;
  readonly read?: (path: string) => string;
}

export interface SecretsStats {
  requests: number;
  lastRequestReplacements: number;
  restoredCalls: number;
  restoredPlaceholders: number;
  failures: number;
}

export interface SecretsSession {
  readonly registry: SecretRegistry;
  readonly key: PlaceholderKey;
  readonly config: SecretsConfig;
  readonly stats: SecretsStats;
}

type RequestMessages = Parameters<typeof mapMessages>[0];

export function createSecretsSession(input: SecretsSessionInput): SecretsSession {
  const config = loadSecretsConfig(
    [
      {
        scope: "user",
        path: join(input.agentDir, CONFIG_FILE_NAME),
        trusted: true,
      },
      {
        scope: "project",
        path: join(input.projectConfigDir, CONFIG_FILE_NAME),
        trusted: input.projectTrusted,
      },
    ],
    input.read,
  );
  const key = loadPlaceholderKey(join(input.agentDir, KEY_FILE_NAME));
  // The key is masked like any secret: a tool reading its file must not ship it to the provider.
  const keyLiteral: LiteralSecret = {
    value: key.key,
    label: "PI_SECRETS_KEY",
    source: "placeholderKey",
  };
  const registry = new SecretRegistry({
    key: key.key,
    literals: [...config.literals, ...collectEnvironmentSecrets(input.env), keyLiteral],
    patterns: [...config.patterns, ...builtinPatterns()],
  });
  return {
    registry,
    key,
    config,
    stats: {
      requests: 0,
      lastRequestReplacements: 0,
      restoredCalls: 0,
      restoredPlaceholders: 0,
      failures: 0,
    },
  };
}

/** Obfuscate one provider-bound transcript; `messages` is never mutated. */
export function obfuscateRequest(session: SecretsSession, messages: RequestMessages) {
  let replacements = 0;
  const result = mapMessages(messages, (text) => {
    const obfuscated = session.registry.obfuscate(text);
    replacements += obfuscated.count;
    return obfuscated.text;
  });
  session.stats.requests += 1;
  session.stats.lastRequestReplacements = replacements;
  return result;
}

/** Restore placeholders in tool-call input in place; returns the number restored. */
export function restoreToolInput(session: SecretsSession, input: object): number {
  let restored = 0;
  mapStringsInPlace(input, (text) => {
    const result = session.registry.restore(text);
    restored += result.count;
    return result.text;
  });
  if (restored > 0) {
    session.stats.restoredCalls += 1;
    session.stats.restoredPlaceholders += restored;
  }
  return restored;
}

const SOURCE_NAMES: Record<SecretSource, string> = {
  config: "configured values",
  environment: "environment variables",
  environmentUrl: "URL passwords in environment variables",
  placeholderKey: "placeholder key",
  configPattern: "found by configured patterns",
  builtinPattern: "found by built-in token patterns",
};

/** Counts only: no value, placeholder or label ever appears in the report. */
export function formatStatus(session: SecretsSession | undefined): string {
  if (session === undefined) return "Secret obfuscation is not active for this session.";
  const counts = session.registry.counts();
  const lines = ["Secret obfuscation is active.", "Tracked secrets:"];
  for (const source of SOURCE_ORDER) lines.push(`  ${counts[source]} ${SOURCE_NAMES[source]}`);
  const files = session.config.files.map((file) =>
    file.status === "loaded"
      ? `${file.scope}: ${file.values} value(s), ${file.patterns} pattern(s)`
      : `${file.scope}: ${file.status}`,
  );
  lines.push(`Configuration (${CONFIG_FILE_NAME}): ${files.join("; ")}`);
  const { stats } = session;
  lines.push(
    `Requests checked: ${stats.requests}; replacements in the last request: ${stats.lastRequestReplacements}`,
    `Tool calls restored: ${stats.restoredCalls} (${stats.restoredPlaceholders} placeholder(s))`,
    session.key.persistent
      ? "Placeholder key: persistent"
      : `Placeholder key: this process only (key file ${session.key.problem ?? "unavailable"}); placeholders change after a restart`,
  );
  if (stats.failures > 0) lines.push(`Requests withheld after a rewrite failure: ${stats.failures}`);
  for (const warning of session.config.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}
