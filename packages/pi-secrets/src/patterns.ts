import { DEFAULT_LABEL, labelRevealsSecret, MIN_SECRET_LENGTH, sanitizeLabel } from "./placeholder.js";

export type SecretSource =
  | "config"
  | "environment"
  | "environmentUrl"
  | "placeholderKey"
  | "configPattern"
  | "builtinPattern";

export const SOURCE_ORDER: readonly SecretSource[] = [
  "config",
  "environment",
  "environmentUrl",
  "placeholderKey",
  "configPattern",
  "builtinPattern",
];

/** A known secret value. */
export interface LiteralSecret {
  readonly value: string;
  readonly label: string;
  readonly source: SecretSource;
}

/** A detector for secrets that are only known once they appear in text. */
export interface SecretPattern {
  readonly label: string;
  readonly source: SecretSource;
  /** Compiled with `g` and `d`; `lastIndex` is never relied on (`matchAll` copies it). */
  readonly regex: RegExp;
  /** Capture group holding the secret; the whole match when omitted. */
  readonly group?: number;
  /**
   * Literal substrings at least one of which every match contains. The scan is
   * skipped for text containing none of them; lowercase for case-insensitive patterns.
   */
  readonly prefixes?: readonly string[];
  readonly accept?: (secret: string) => boolean;
}

interface BuiltinPatternSpec {
  readonly label: string;
  readonly source: string;
  readonly flags?: string;
  readonly group?: number;
  readonly prefixes: readonly string[];
  readonly accept?: (secret: string) => boolean;
}

// Token boundaries: a vendor prefix inside a longer identifier is not a token.
const B = "(?<![A-Za-z0-9_-])";
const E = "(?![A-Za-z0-9_-])";

/** At least two of lowercase, uppercase, digit and other characters. */
function hasMixedCharacters(secret: string): boolean {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(secret)).length >= 2;
}

/**
 * Vendor-anchored credential shapes only. There are no keyword or entropy
 * rules: an agent must still read identifiers such as `token_expiry_seconds`.
 * Order breaks ties between patterns that match the same span.
 */
const BUILTIN_PATTERNS: readonly BuiltinPatternSpec[] = [
  {
    label: "PRIVATE_KEY",
    source:
      "-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\\s\\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----",
    prefixes: ["-----BEGIN "],
  },
  {
    label: "ANTHROPIC_API_KEY",
    source: `${B}sk-ant-[A-Za-z0-9_-]{32,}${E}`,
    prefixes: ["sk-ant-"],
  },
  {
    label: "OPENROUTER_API_KEY",
    source: `${B}sk-or-v1-[A-Za-z0-9]{32,}${E}`,
    prefixes: ["sk-or-v1-"],
  },
  {
    label: "OPENAI_API_KEY",
    source: `${B}sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}|[A-Za-z0-9]{40,})${E}`,
    prefixes: ["sk-"],
  },
  {
    label: "GROQ_API_KEY",
    source: `${B}gsk_[A-Za-z0-9]{40,}${E}`,
    prefixes: ["gsk_"],
  },
  {
    label: "XAI_API_KEY",
    source: `${B}xai-[A-Za-z0-9]{40,}${E}`,
    prefixes: ["xai-"],
  },
  {
    label: "GITHUB_TOKEN",
    source: `${B}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})${E}`,
    prefixes: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"],
  },
  {
    label: "GITLAB_TOKEN",
    source: `${B}gl(?:pat|ptt|dt|rt)-[A-Za-z0-9_-]{20,}${E}`,
    prefixes: ["glpat-", "glptt-", "gldt-", "glrt-"],
  },
  {
    label: "SLACK_TOKEN",
    source: `${B}(?:xox[abposr]-[A-Za-z0-9-]{10,}|xapp-[0-9]-[A-Za-z0-9-]{10,})${E}`,
    prefixes: ["xoxa-", "xoxb-", "xoxp-", "xoxo-", "xoxs-", "xoxr-", "xapp-"],
  },
  {
    label: "SLACK_WEBHOOK",
    source: "https://hooks\\.slack\\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]{20,}",
    prefixes: ["hooks.slack.com/services/"],
  },
  {
    label: "AWS_ACCESS_KEY_ID",
    source: `${B}(?:AKIA|ASIA)[A-Z0-9]{16}${E}`,
    prefixes: ["AKIA", "ASIA"],
  },
  {
    // A secret access key has no prefix of its own; only its well-known setting name identifies it.
    label: "AWS_SECRET_ACCESS_KEY",
    source: "aws_secret_access_key[\"']?\\s*[:=]\\s*[\"']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])",
    flags: "i",
    group: 1,
    prefixes: ["aws_secret_access_key"],
  },
  {
    label: "GOOGLE_API_KEY",
    source: `${B}AIza[A-Za-z0-9_-]{35}${E}`,
    prefixes: ["AIza"],
  },
  {
    label: "GOOGLE_OAUTH_TOKEN",
    source: `${B}ya29\\.[A-Za-z0-9_-]{20,}${E}`,
    prefixes: ["ya29."],
  },
  {
    label: "NPM_TOKEN",
    source: `${B}npm_[A-Za-z0-9]{36,}${E}`,
    prefixes: ["npm_"],
  },
  {
    label: "STRIPE_KEY",
    source: `${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}${E}`,
    prefixes: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"],
  },
  {
    label: "STRIPE_WEBHOOK_SECRET",
    source: `${B}whsec_[A-Za-z0-9]{20,}${E}`,
    prefixes: ["whsec_"],
  },
  {
    label: "HUGGINGFACE_TOKEN",
    source: `${B}hf_[A-Za-z0-9]{30,}${E}`,
    prefixes: ["hf_"],
  },
  {
    label: "JWT",
    source: `${B}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}${E}`,
    prefixes: ["eyJ"],
  },
  {
    // `scheme://user:password@host`; placeholder-like words such as `password` are left alone.
    label: "URL_PASSWORD",
    source: `[A-Za-z][A-Za-z0-9+.-]*://[^\\s/:@?#]*:([^\\s/@?#]{${MIN_SECRET_LENGTH},})@`,
    group: 1,
    prefixes: ["://"],
    accept: hasMixedCharacters,
  },
];

export function compilePattern(source: string, flags = ""): RegExp {
  const unique = new Set([...flags.replace(/[gd]/g, ""), "g", "d"]);
  return new RegExp(source, [...unique].join(""));
}

export function builtinPatterns(): SecretPattern[] {
  return BUILTIN_PATTERNS.map((spec) => ({
    label: spec.label,
    source: "builtinPattern",
    regex: compilePattern(spec.source, spec.flags),
    ...(spec.group === undefined ? {} : { group: spec.group }),
    prefixes: spec.flags?.includes("i") ? spec.prefixes.map((prefix) => prefix.toLowerCase()) : spec.prefixes,
    ...(spec.accept ? { accept: spec.accept } : {}),
  }));
}

// Long keywords also match when glued to a prefix (PGPASSWORD, CLIENTSECRET);
// short ones must be a whole `_` segment so MONKEY and GIT_ASKPASS stay out.
const GLUED_SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|APIKEY)(?:_|$)/i;
const SEGMENT_SECRET_NAME = /(?:^|_)(?:KEY|PASS|PWD|PAT|AUTH|PRIVATE|OAUTH)(?:_|$)/i;
// A final segment naming where a secret lives, or who owns it, rather than the secret itself.
const REFERENCE_SUFFIX =
  /_(?:FILE|PATH|DIR|SOCK|SOCKET|URL|URI|HOST|PORT|ID|USER|USERNAME|NAME|TYPE|MODE|COMMAND|CMD|HELPER)$/i;
const NOT_SECRET_NAMES = new Set(["PWD", "OLDPWD"]);

export function isSecretEnvName(name: string): boolean {
  if (NOT_SECRET_NAMES.has(name.toUpperCase()) || REFERENCE_SUFFIX.test(name)) return false;
  return GLUED_SECRET_NAME.test(name) || SEGMENT_SECRET_NAME.test(name);
}

const URL_PASSWORD = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@?#]*:([^\s/@?#]+)@/g;

/** Raw and percent-decoded passwords embedded in `scheme://user:password@host` values. */
export function urlPasswords(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(URL_PASSWORD)) {
    const raw = match[1];
    if (raw === undefined) continue;
    found.push(raw);
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded !== raw) found.push(decoded);
    } catch {
      // Malformed percent-encoding: the raw form is already collected.
    }
  }
  return found.filter((password) => password.length >= MIN_SECRET_LENGTH);
}

/**
 * Environment values that look secret, ordered by variable name so labels
 * are stable across runs. A value shared by several variables is tracked once.
 */
export function collectEnvironmentSecrets(env: Readonly<Record<string, string | undefined>>): LiteralSecret[] {
  const secrets: LiteralSecret[] = [];
  const seen = new Set<string>();
  const names = Object.keys(env).sort();
  for (const name of names) {
    const value = env[name];
    if (value === undefined || value.length < MIN_SECRET_LENGTH || !isSecretEnvName(name) || seen.has(value)) continue;
    seen.add(value);
    secrets.push({
      value,
      label: safeLabel(name, value),
      source: "environment",
    });
  }
  // URL passwords count regardless of the variable name (DATABASE_URL, REDIS_URL, ...).
  for (const name of names) {
    for (const password of urlPasswords(env[name] ?? "")) {
      if (seen.has(password)) continue;
      seen.add(password);
      secrets.push({
        value: password,
        label: safeLabel(`${name}_PASSWORD`, password),
        source: "environmentUrl",
      });
    }
  }
  return secrets;
}

/** A sanitized label that does not contain the value it stands for. */
export function safeLabel(name: string | undefined, value?: string): string {
  const label = name === undefined ? undefined : sanitizeLabel(name);
  if (label === undefined || (value !== undefined && labelRevealsSecret(label, value))) return DEFAULT_LABEL;
  return label;
}
