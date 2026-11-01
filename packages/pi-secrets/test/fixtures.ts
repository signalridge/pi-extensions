import { builtinPatterns } from "../src/patterns.js";
import { PLACEHOLDER_PATTERN } from "../src/placeholder.js";
import { SecretRegistry } from "../src/registry.js";

/**
 * Credential-shaped fixtures are assembled at runtime so the repository's
 * secret scanner never sees a complete token in source.
 */
export const fake = (...parts: string[]): string => parts.join("");

export const tokens = {
  anthropic: fake("sk", "-ant-", "api03-", "Ab3_".repeat(10)),
  openaiProject: fake("sk", "-proj-", "Cd4e".repeat(10)),
  openaiLegacy: fake("sk", "-", "Ef5G".repeat(12)),
  openrouter: fake("sk", "-or-v1-", "a1b2".repeat(16)),
  github: fake("gh", "p_", "Gh6i".repeat(9)),
  githubFineGrained: fake("github", "_pat_", "11ABCDEFG0", "_", "Jk7l".repeat(15)),
  gitlab: fake("gl", "pat-", "Mn8o".repeat(5)),
  slack: fake("xo", "xb-", "1234567890-", "Pq9r".repeat(4)),
  slackWebhook: fake("https://hooks.slack.com/services/", "T0ABCDEF/", "B0ABCDEF/", "St0u".repeat(6)),
  awsAccessKeyId: fake("AK", "IA", "QRSTUVWXYZ234567"),
  awsSecret: fake("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"),
  google: fake("AI", "za", "Vw1x".repeat(8), "Yz2"),
  googleOauth: fake("ya", "29.", "Ab3c".repeat(6)),
  npm: fake("np", "m_", "De4f".repeat(9)),
  stripe: fake("sk", "_live_", "Gh5i".repeat(6)),
  stripeWebhook: fake("wh", "sec_", "Jk6l".repeat(6)),
  huggingface: fake("h", "f_", "Mn7o".repeat(8)),
  jwt: fake(
    "ey",
    "JhbGciOiJIUzI1NiJ9",
    ".",
    "ey",
    "JzdWIiOiIxMjM0NTY3ODkwIn0",
    ".",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
  ),
  privateKey: fake(
    "-----BEGIN ",
    "OPENSSH PRIVATE KEY-----\n",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n",
    "-----END ",
    "OPENSSH PRIVATE KEY-----",
  ),
} as const;

export function builtinRegistry(key = "test-key"): SecretRegistry {
  return new SecretRegistry({ key, literals: [], patterns: builtinPatterns() });
}

/** Labels of the placeholders in `text`, in order. */
export function labelsIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[0].slice(2, -15));
}
