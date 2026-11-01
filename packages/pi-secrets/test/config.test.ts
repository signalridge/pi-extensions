import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlaceholderKey, loadSecretsConfig } from "../src/config.js";
import { SecretRegistry } from "../src/registry.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-secrets-config-"));
  roots.push(root);
  return root;
}

const files = (contents: Record<string, string>) => (path: string) => {
  const text = contents[path];
  if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return text;
};

describe("loadSecretsConfig", () => {
  it("loads values and patterns from the user file and a trusted project file", () => {
    const config = loadSecretsConfig(
      [
        { scope: "user", path: "/user.json", trusted: true },
        { scope: "project", path: "/project.json", trusted: true },
      ],
      files({
        "/user.json": JSON.stringify({
          secrets: [{ name: "Staging DB", value: "staging-db-pass" }],
        }),
        "/project.json": JSON.stringify({
          secrets: [{ name: "Corp token", pattern: "corp_[a-z0-9]{10}", flags: "i" }],
        }),
      }),
    );
    expect(config.warnings).toEqual([]);
    expect(config.literals).toEqual([{ value: "staging-db-pass", label: "STAGING_DB", source: "config" }]);
    expect(config.patterns).toHaveLength(1);
    expect(config.patterns[0]).toMatchObject({
      label: "CORP_TOKEN",
      source: "configPattern",
    });
    expect(config.patterns[0]?.regex.flags).toBe("dgi");
    expect(config.files).toEqual([
      { scope: "user", status: "loaded", values: 1, patterns: 0 },
      { scope: "project", status: "loaded", values: 0, patterns: 1 },
    ]);
    const registry = new SecretRegistry({
      key: "k",
      literals: config.literals,
      patterns: config.patterns,
    });
    expect(registry.obfuscate("staging-db-pass CORP_ABCDEFGHIJ").count).toBe(2);
  });

  it("does not read a project file unless the project is trusted", () => {
    const read = (path: string): string => {
      throw new Error(`unexpected read of ${path}`);
    };
    const config = loadSecretsConfig([{ scope: "project", path: "/project.json", trusted: false }], read);
    expect(config.files).toEqual([{ scope: "project", status: "untrusted", values: 0, patterns: 0 }]);
    expect(config.warnings).toEqual([]);
  });

  it("treats a missing file as empty and reports invalid files without echoing values", () => {
    const config = loadSecretsConfig(
      [
        { scope: "user", path: "/missing.json", trusted: true },
        { scope: "project", path: "/bad.json", trusted: true },
      ],
      files({ "/bad.json": "{ not json" }),
    );
    expect(config.files.map((file) => file.status)).toEqual(["missing", "invalid"]);
    expect(config.warnings).toEqual(["project pi-secrets.json: invalid JSON"]);
    expect(
      loadSecretsConfig([{ scope: "user", path: "/a.json", trusted: true }], files({ "/a.json": "[]" })).warnings,
    ).toEqual(['user pi-secrets.json: expected an object with a "secrets" array']);
  });

  it("skips invalid entries individually with indexed warnings", () => {
    const config = loadSecretsConfig(
      [{ scope: "user", path: "/user.json", trusted: true }],
      files({
        "/user.json": JSON.stringify({
          secrets: [
            "bare-string",
            { value: "short" },
            { value: "long-enough-value", pattern: "x+" },
            { pattern: "(" },
            { pattern: "abc", flags: "g" },
            { name: 7, value: "long-enough-value" },
            { value: "kept-secret-value", comment: "extra" },
          ],
        }),
      }),
    );
    expect(config.literals.map((entry) => entry.value)).toEqual(["kept-secret-value"]);
    expect(config.warnings).toEqual([
      "user pi-secrets.json secrets[0]: an entry must be an object",
      'user pi-secrets.json secrets[1]: "value" must be a string of at least 8 characters',
      'user pi-secrets.json secrets[2]: set exactly one of "value" or "pattern"',
      'user pi-secrets.json secrets[3]: "pattern" is not a valid regular expression',
      'user pi-secrets.json secrets[4]: "flags" may contain only i, m, s, u and v',
      'user pi-secrets.json secrets[5]: "name" must be a string',
      'user pi-secrets.json secrets[6]: unknown key "comment" ignored',
    ]);
    expect(config.warnings.join("\n")).not.toContain("long-enough-value");
  });
});

describe("loadPlaceholderKey", () => {
  it("creates a private key file once and reuses it", () => {
    const path = join(tempDir(), "agent", "pi-secrets.key");
    const first = loadPlaceholderKey(path);
    expect(first.persistent).toBe(true);
    expect(first.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(path, "utf8")).toBe(first.key);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadPlaceholderKey(path)).toEqual(first);
  });

  it("leaves an invalid key file untouched and uses a process-only key", () => {
    const path = join(tempDir(), "pi-secrets.key");
    writeFileSync(path, "not a key");
    const key = loadPlaceholderKey(path);
    expect(key).toMatchObject({
      persistent: false,
      problem: "unreadable or invalid",
    });
    expect(readFileSync(path, "utf8")).toBe("not a key");
  });

  it.skipIf(process.getuid?.() === 0)("falls back to a process-only key when the directory is not writable", () => {
    const dir = join(tempDir(), "locked");
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      expect(loadPlaceholderKey(join(dir, "pi-secrets.key"))).toMatchObject({
        persistent: false,
        problem: "could not be created",
      });
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
