import { createHmac, randomBytes } from "node:crypto";

/** Values shorter than this are never obfuscated, so ordinary short words stay readable. */
export const MIN_SECRET_LENGTH = 8;
export const DEFAULT_LABEL = "SECRET";

const HASH_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const HASH_LENGTH = 12;
const MAX_LABEL_LENGTH = 32;

/**
 * Every placeholder this package emits, known to the current registry or not:
 * `$$LABEL_HASH$$` with an uppercase label and a 12-character base-36 hash.
 */
export const PLACEHOLDER_PATTERN = /\$\$[A-Z][A-Z0-9_]*_[A-Z0-9]{12}\$\$/g;

/** Keyed digest of a secret. Tests inject a weak digest to force collisions. */
export type SecretDigest = (key: string, value: string) => Uint8Array;

export const hmacDigest: SecretDigest = (key, value) => createHmac("sha256", key).update(value, "utf8").digest();

export function generatePlaceholderKey(): string {
  return randomBytes(32).toString("base64url");
}

/** Render the first 64 digest bits as 12 base-36 characters (about 62 bits). */
export function hashBase(digest: Uint8Array): string {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(digest[index] ?? 0);
  const radix = BigInt(HASH_ALPHABET.length);
  let out = "";
  for (let index = 0; index < HASH_LENGTH; index += 1) {
    out += HASH_ALPHABET[Number(value % radix)];
    value /= radix;
  }
  return out;
}

/** Normalize a model-visible label to `[A-Z][A-Z0-9_]*`, or `undefined` when nothing usable remains. */
export function sanitizeLabel(name: string): string | undefined {
  const label = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/_+$/, "");
  return /^[A-Z]/.test(label) ? label : undefined;
}

/** Whether a label would reveal a secret, compared on letters and digits only. */
export function labelRevealsSecret(label: string, secret: string): boolean {
  const normalizedSecret = secret.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalizedSecret.length < MIN_SECRET_LENGTH) return false;
  return label.replace(/[^A-Z0-9]/g, "").includes(normalizedSecret);
}

/**
 * Derive the placeholder for one attempt. Attempt 0 is the normal keyed hash;
 * later attempts salt the digest so a hash collision with a different value
 * still yields a distinct placeholder.
 */
export function buildPlaceholder(
  digest: SecretDigest,
  key: string,
  label: string,
  value: string,
  attempt: number,
): string {
  const input = attempt === 0 ? value : `${attempt}\u0000${value}`;
  return `$$${label}_${hashBase(digest(key, input))}$$`;
}
