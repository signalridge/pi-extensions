import { describe, expect, it } from "vitest";
import { collectEnvironmentSecrets, isSecretEnvName, urlPasswords } from "../src/patterns.js";
import { builtinRegistry, fake, labelsIn, tokens } from "./fixtures.js";

describe("built-in token patterns", () => {
  const positives: [keyof typeof tokens, string][] = [
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openaiProject", "OPENAI_API_KEY"],
    ["openaiLegacy", "OPENAI_API_KEY"],
    ["openrouter", "OPENROUTER_API_KEY"],
    ["github", "GITHUB_TOKEN"],
    ["githubFineGrained", "GITHUB_TOKEN"],
    ["gitlab", "GITLAB_TOKEN"],
    ["slack", "SLACK_TOKEN"],
    ["slackWebhook", "SLACK_WEBHOOK"],
    ["awsAccessKeyId", "AWS_ACCESS_KEY_ID"],
    ["google", "GOOGLE_API_KEY"],
    ["googleOauth", "GOOGLE_OAUTH_TOKEN"],
    ["npm", "NPM_TOKEN"],
    ["stripe", "STRIPE_KEY"],
    ["stripeWebhook", "STRIPE_WEBHOOK_SECRET"],
    ["huggingface", "HUGGINGFACE_TOKEN"],
    ["jwt", "JWT"],
    ["privateKey", "PRIVATE_KEY"],
  ];

  for (const [name, label] of positives) {
    it(`replaces a ${name} token with a ${label} placeholder`, () => {
      const token = tokens[name];
      const result = builtinRegistry().obfuscate(`before "${token}" after`);
      expect(result.count).toBe(1);
      expect(result.text).not.toContain(token);
      expect(labelsIn(result.text)).toEqual([label]);
      expect(result.text.startsWith('before "$$')).toBe(true);
      expect(result.text.endsWith('$$" after')).toBe(true);
    });
  }

  it("captures only the secret part of an AWS credentials line and a URL password", () => {
    const registry = builtinRegistry();
    const aws = registry.obfuscate(`aws_secret_access_key = ${tokens.awsSecret}\n`);
    expect(aws.text).toMatch(/^aws_secret_access_key = \$\$AWS_SECRET_ACCESS_KEY_[A-Z0-9]{12}\$\$\n$/);
    const url = registry.obfuscate("postgres://app:Hunter2-Hunter2@db.internal:5432/app");
    expect(url.text).toMatch(/^postgres:\/\/app:\$\$URL_PASSWORD_[A-Z0-9]{12}\$\$@db\.internal:5432\/app$/);
  });

  it("leaves lookalikes alone", () => {
    const lookalikes = [
      "token_expiry_seconds = 3600; const apiKeyHeader = 'x-api-key';",
      fake("my", "ghp_", "Gh6i".repeat(9)), // prefix glued into a longer identifier
      fake("gh", "p_", "short"),
      fake("risk-", "Ef5G".repeat(12)),
      fake("sk", "-", "Ef5G".repeat(5)),
      fake("AK", "IA", "lowercase123456789"),
      fake("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0"), // two segments
      "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----",
      "https://user:password@example.com and https://user:changeme@example.com",
      "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "id: 123e4567-e89b-12d3-a456-426614174000",
      "git@github.com:signalridge/pi-extensions.git",
    ];
    const registry = builtinRegistry();
    for (const text of lookalikes) expect(registry.obfuscate(text)).toEqual({ text, count: 0 });
    expect(registry.counts().builtinPattern).toBe(0);
  });
});

describe("environment heuristics", () => {
  it("recognizes secret-looking variable names", () => {
    for (const name of [
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "PGPASSWORD",
      "MYSQL_PWD",
      "CLIENTSECRET",
      "GH_PAT",
      "npm_config__authToken",
      "DB_PASS",
      "PRIVATE_KEY",
    ]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
  });

  it("ignores names that only reference or resemble secrets", () => {
    for (const name of [
      "PATH",
      "HOME",
      "PWD",
      "OLDPWD",
      "MONKEY",
      "KEYTIMEOUT",
      "GIT_ASKPASS",
      "SSH_AUTH_SOCK",
      "AWS_ACCESS_KEY_ID",
      "PASSWORD_STORE_DIR",
      "GOOGLE_APPLICATION_CREDENTIALS_FILE",
      "TOKENIZERS_PARALLELISM",
    ]) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });

  it("collects values of at least eight characters once, labelled by sorted name", () => {
    const secrets = collectEnvironmentSecrets({
      Z_API_TOKEN: "shared-value-1",
      A_API_TOKEN: "shared-value-1",
      SHORT_TOKEN: "seven77",
      HOME: "/home/someone",
      DATABASE_URL: "postgres://app:p%40ss-w0rd-9@db:5432/app",
      REDIS_URL: "redis://cache:6379",
    });
    expect(secrets).toEqual([
      { value: "shared-value-1", label: "A_API_TOKEN", source: "environment" },
      {
        value: "p%40ss-w0rd-9",
        label: "DATABASE_URL_PASSWORD",
        source: "environmentUrl",
      },
      {
        value: "p@ss-w0rd-9",
        label: "DATABASE_URL_PASSWORD",
        source: "environmentUrl",
      },
    ]);
  });

  it("extracts URL passwords anywhere in a value", () => {
    expect(urlPasswords("jdbc:postgresql://app:Secret-123@db/app")).toEqual(["Secret-123"]);
    expect(urlPasswords("https://example.com/path")).toEqual([]);
    expect(urlPasswords("redis://:shortpw@cache")).toEqual([]);
  });
});
