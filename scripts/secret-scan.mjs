import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const ignored = new Set([".git", "node_modules", "coverage", "dist", ".release", ".pi"]);
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
]);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?:[^A-Za-z0-9]|$)/,
  /(?:ghp|github_pat|npm|pypi)_[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
];
const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (ignored.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (textExtensions.has(path.slice(path.lastIndexOf(".")))) {
      const text = readFileSync(path, "utf8");
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          hits.push(`${path}: ${pattern}`);
          break;
        }
      }
    }
  }
}
walk(root);
if (hits.length > 0) {
  console.error("secret-scan: possible credentials found:");
  for (const hit of hits) console.error(hit);
  process.exit(1);
}
console.log("secret-scan: no credential-like material found");
