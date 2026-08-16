import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const includeExperimental = process.argv.includes("--include-experimental");
const dryRun = process.argv.includes("--dry-run");
const selected = process.argv.find((arg) => arg.startsWith("--package="))?.slice("--package=".length);

const packageDirs = readdirSync(join(root, "packages"))
  .filter((name) => statSync(join(root, "packages", name)).isDirectory())
  .filter((name) => !selected || name === selected)
  .sort();
if (packageDirs.length === 0) throw new Error(selected ? `unknown package: ${selected}` : "no packages found");

if (!dryRun) {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (status.status !== 0) throw new Error(status.stderr || "could not inspect git status");
  if (status.stdout.trim()) throw new Error("refusing to tag with a dirty working tree");
}

let tagged = 0;
for (const name of packageDirs) {
  const packageRoot = join(root, "packages", name);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (manifest.piExtension?.lifecycle === "experimental" && !includeExperimental) continue;
  const tag = `pkg/${manifest.name}@${manifest.version}`;
  const existing = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd: root, stdio: "ignore" });
  if (existing.status === 0) throw new Error(`tag already exists: ${tag}`);
  console.log(`${dryRun ? "would tag" : "tagging"} ${tag}`);
  if (!dryRun) {
    const result = spawnSync("git", ["tag", "-a", tag, "-m", `${manifest.name} ${manifest.version}`], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  tagged += 1;
}
console.log(`tag-packages: ${dryRun ? "validated" : "created"} ${tagged} tag(s)`);
