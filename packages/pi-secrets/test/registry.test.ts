import { describe, expect, it } from "vitest";
import { builtinPatterns, compilePattern, type LiteralSecret, safeLabel } from "../src/patterns.js";
import { hmacDigest, PLACEHOLDER_PATTERN } from "../src/placeholder.js";
import { SecretRegistry } from "../src/registry.js";
import { mapMessages } from "../src/transform.js";
import { labelsIn, tokens } from "./fixtures.js";

const literal = (value: string, label = "DEMO_TOKEN"): LiteralSecret => ({
  value,
  label,
  source: "environment",
});
const registry = (literals: LiteralSecret[], key = "key-a") => new SecretRegistry({ key, literals, patterns: [] });

describe("placeholders", () => {
  it("are deterministic per key and value, across calls and registry instances", () => {
    const first = registry([literal("value-one-123")]).obfuscate("use value-one-123 twice: value-one-123");
    const second = registry([literal("value-one-123")]).obfuscate("use value-one-123 twice: value-one-123");
    expect(first).toEqual(second);
    expect(first.count).toBe(2);
    const [a, b] = [...first.text.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[0]);
    expect(a).toBe(b);
    expect(a).toMatch(/^\$\$DEMO_TOKEN_[A-Z0-9]{12}\$\$$/);
    const otherKey = registry([literal("value-one-123")], "key-b").obfuscate("value-one-123");
    expect(otherKey.text).not.toBe(a);
  });

  it("round-trip and re-obfuscation is idempotent", () => {
    const secrets = registry([literal("value-one-123"), literal("value-two-456", "OTHER")]);
    const original = "a=value-one-123 b=value-two-456";
    const obfuscated = secrets.obfuscate(original);
    expect(secrets.obfuscate(obfuscated.text)).toEqual({
      text: obfuscated.text,
      count: 0,
    });
    expect(secrets.restore(obfuscated.text)).toEqual({
      text: original,
      count: 2,
    });
  });

  it("stay distinct when the digest collides", () => {
    const secrets = new SecretRegistry({
      key: "key-a",
      literals: [literal("first-secret-1"), literal("second-secret-2")],
      patterns: [],
      // Every first attempt collides; salted retries fall back to the real digest.
      digest: (key, input) => (input.includes("\u0000") ? hmacDigest(key, input) : new Uint8Array(32)),
    });
    const text = secrets.obfuscate("first-secret-1 second-secret-2").text;
    const placeholders = [...text.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[0]);
    expect(new Set(placeholders).size).toBe(2);
    expect(secrets.restore(text).text).toBe("first-secret-1 second-secret-2");
  });

  it("fail instead of spinning when a digest can never separate two values", () => {
    expect(
      () =>
        new SecretRegistry({
          key: "key-a",
          literals: [literal("first-secret-1"), literal("second-secret-2")],
          patterns: [],
          digest: () => new Uint8Array(32),
        }),
    ).toThrow("keeps colliding");
  });

  it("restore only placeholders this registry issued and never interprets replacement patterns", () => {
    const tricky = "pa$$word-$&-$1-$`";
    const secrets = registry([literal(tricky)]);
    const obfuscated = secrets.obfuscate(`x ${tricky} y`).text;
    const unknown = "$$DEMO_TOKEN_ABCDEFGHIJKL$$";
    expect(secrets.restore(`${obfuscated} ${unknown}`)).toEqual({
      text: `x ${tricky} y ${unknown}`,
      count: 1,
    });
  });

  it("redacts secrets inside fabricated placeholders but preserves genuinely issued ones", () => {
    const secrets = registry([literal("ABCDEF123456", "ABCDEF123456")]);
    const text = "model wrote $$ABCDEF123456_000000000000$$";
    const masked = secrets.obfuscate(text);
    expect(masked.count).toBe(1);
    expect(secrets.restore(masked.text)).toEqual({ text, count: 1 });
    expect(secrets.obfuscate(masked.text)).toEqual({ text: masked.text, count: 0 });
    expect(secrets.restore("$$UNKNOWN_000000000000$$")).toEqual({ text: "$$UNKNOWN_000000000000$$", count: 0 });
  });

  it("merge overlapping secrets so no tail stays in clear text, and restore the exact span", () => {
    const secrets = registry([literal("ABCDEFGHIJ"), literal("FGHIJKLMNOP", "SECOND")]);
    const obfuscated = secrets.obfuscate("<ABCDEFGHIJKLMNOP>");
    expect(obfuscated.count).toBe(1);
    expect(obfuscated.text).toMatch(/^<\$\$DEMO_TOKEN_[A-Z0-9]{12}\$\$>$/);
    expect(secrets.restore(obfuscated.text).text).toBe("<ABCDEFGHIJKLMNOP>");
    expect(secrets.counts().environment).toBe(2);
  });

  it("prefer the longest secret at the same position", () => {
    const secrets = registry([literal("prefix-1234"), literal("prefix-1234-suffix", "LONGER")]);
    expect(labelsIn(secrets.obfuscate("prefix-1234-suffix").text)).toEqual(["LONGER"]);
  });

  it("ignore literals shorter than eight characters", () => {
    expect(registry([literal("short12")]).obfuscate("short12 short12")).toEqual({
      text: "short12 short12",
      count: 0,
    });
  });

  it("do not let a label reveal the value it stands for", () => {
    expect(safeLabel("token hunter2hunter2", "hunter2hunter2")).toBe("SECRET");
    expect(safeLabel("Staging DB password", "hunter2hunter2")).toBe("STAGING_DB_PASSWORD");
    expect(safeLabel("42", "hunter2hunter2")).toBe("SECRET");
    expect(safeLabel(undefined)).toBe("SECRET");
  });
});

describe("pattern-detected secrets", () => {
  it("are learned once, keep their placeholder, and restore", () => {
    const secrets = new SecretRegistry({
      key: "key-a",
      literals: [],
      patterns: builtinPatterns(),
    });
    const first = secrets.obfuscate(`token ${tokens.github}`);
    const second = secrets.obfuscate(`again ${tokens.github}`);
    expect(first.text.slice(6)).toBe(second.text.slice(6));
    expect(secrets.counts().builtinPattern).toBe(1);
    expect(secrets.restore(second.text).text).toBe(`again ${tokens.github}`);
  });

  it("does not learn an issued placeholder as a URL password on re-obfuscation", () => {
    const secrets = new SecretRegistry({ key: "key", literals: [], patterns: builtinPatterns() });
    const url = "https://user:Abc12345!@example.test/path";
    const first = secrets.obfuscate(url);
    expect(first.count).toBe(1);
    expect(secrets.counts().builtinPattern).toBe(1);
    const counts = secrets.counts();
    expect(secrets.obfuscate(first.text)).toEqual({ text: first.text, count: 0 });
    expect(secrets.counts()).toEqual(counts);
    expect(secrets.restore(first.text).text).toBe(url);
    // Shape alone is not reserved, even in the same URL-password context.
    const fake = "https://user:$$ABCDEF123456_000000000000$$@example.test/path";
    const configured = new SecretRegistry({
      key: "key",
      literals: [literal("ABCDEF123456")],
      patterns: builtinPatterns(),
    });
    const redacted = configured.obfuscate(fake);
    expect(redacted.count).toBe(1);
    expect(redacted.text).not.toContain("ABCDEF123456");
    expect(configured.restore(redacted.text).text).toBe(fake);
  });

  it("learns contextual captures as literals, including bare occurrences in the same text and later messages", () => {
    const value = "Ab1/".repeat(10);
    const secrets = new SecretRegistry({ key: "key", literals: [], patterns: builtinPatterns() });
    const discovered = secrets.obfuscate(`${value} aws_secret_access_key=${value}`);
    expect(discovered.count).toBe(2);
    expect(discovered.text).not.toContain(value);
    const requestRegistry = new SecretRegistry({ key: "key", literals: [], patterns: builtinPatterns() });
    const request = mapMessages(
      [
        { role: "user", content: `aws_secret_access_key=${value}`, timestamp: 0 },
        { role: "user", content: `bare later in this request: ${value}`, timestamp: 1 },
      ],
      (text) => requestRegistry.obfuscate(text).text,
    );
    expect(JSON.stringify(request.messages)).not.toContain(value);
    expect(requestRegistry.counts().builtinPattern).toBe(1);
    const bare = secrets.obfuscate(`later ${value}`);
    expect(bare.count).toBe(1);
    expect(secrets.restore(bare.text).text).toBe(`later ${value}`);
    expect(secrets.counts().builtinPattern).toBe(1);
    const configured = new SecretRegistry({
      key: "key",
      literals: [{ value, label: "CONFIGURED", source: "config" }],
      patterns: builtinPatterns(),
    });
    expect(labelsIn(configured.obfuscate(`aws_secret_access_key=${value}`).text)).toEqual(["CONFIGURED"]);
    expect(labelsIn(configured.obfuscate(value).text)).toEqual(["CONFIGURED"]);
  });

  it("sanitizes the first pattern label before retaining it or merging overlapping matches", () => {
    const secret = "ULTRASECRETPASSWORD";
    const tail = `${secret.slice(-8)}TAIL`;
    const secrets = new SecretRegistry({
      key: "key",
      literals: [],
      patterns: [
        { label: secret, source: "configPattern", regex: compilePattern(secret) },
        { label: "LATER_SAFE_LABEL", source: "configPattern", regex: compilePattern(secret) },
        { label: "TAIL", source: "configPattern", regex: compilePattern(tail) },
      ],
    });
    // Discovery must not issue a derived overlap placeholder or count replacements.
    expect(secrets.discover(`${secret}TAIL`)).toBeUndefined();
    expect(secrets.counts().configPattern).toBe(2);
    for (const text of [secret, `${secret}TAIL`, `again ${secret}`]) {
      const masked = secrets.obfuscate(text);
      expect(masked.count).toBe(1);
      expect(masked.text).not.toContain(secret);
      expect(labelsIn(masked.text)).toEqual(["SECRET"]);
      expect(secrets.restore(masked.text)).toEqual({ text, count: 1 });
      expect(secrets.obfuscate(masked.text)).toEqual({ text: masked.text, count: 0 });
      expect(secrets.counts().configPattern).toBe(2);
    }
  });

  it("keeps an existing safe first label when a later pattern name reveals the same value", () => {
    const secret = "ULTRASECRETPASSWORD";
    const secrets = new SecretRegistry({
      key: "key",
      literals: [],
      patterns: [
        { label: "FIRST_SAFE", source: "configPattern", regex: compilePattern(secret) },
        { label: secret, source: "configPattern", regex: compilePattern(secret) },
      ],
    });
    secrets.discover(secret);
    const masked = secrets.obfuscate(secret);
    expect(labelsIn(masked.text)).toEqual(["FIRST_SAFE"]);
    expect(secrets.restore(masked.text)).toEqual({ text: secret, count: 1 });
    expect(secrets.counts().configPattern).toBe(1);
  });

  it("give configured literals the label when a literal and a pattern match the same value", () => {
    const secrets = new SecretRegistry({
      key: "key-a",
      literals: [{ value: tokens.github, label: "DEPLOY_TOKEN", source: "config" }],
      patterns: builtinPatterns(),
    });
    expect(labelsIn(secrets.obfuscate(tokens.github).text)).toEqual(["DEPLOY_TOKEN"]);
    expect(secrets.counts()).toMatchObject({ config: 1, builtinPattern: 0 });
  });

  it("skip zero-length and short matches from configured patterns", () => {
    const secrets = new SecretRegistry({
      key: "key-a",
      literals: [],
      patterns: [
        { label: "ANY", source: "configPattern", regex: compilePattern("x*") },
        {
          label: "CORP",
          source: "configPattern",
          regex: compilePattern("corp_[a-z0-9]{10}", "i"),
        },
      ],
    });
    const result = secrets.obfuscate("x xx CORP_ABCDEFGHIJ");
    expect(labelsIn(result.text)).toEqual(["CORP"]);
    expect(result.text.startsWith("x xx $$CORP_")).toBe(true);
  });
});
