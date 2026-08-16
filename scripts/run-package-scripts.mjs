import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const scriptName = process.argv[2];
if (!scriptName) throw new Error("usage: run-package-scripts.mjs <script> [args]");

const internalArgs = new Set(["--require-processed-files"]);
const requireProcessedFiles = process.argv.slice(3).some((arg) => internalArgs.has(arg));
const forwardedArgs = process.argv.slice(3).filter((arg) => !internalArgs.has(arg));

function sourceFileCount(dir) {
  let count = 0;
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", "coverage", ".git"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) count += sourceFileCount(path);
    else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(name)) count += 1;
  }
  return count;
}

const packageDirs = readdirSync(join(root, "packages"))
  .filter((name) => statSync(join(root, "packages", name)).isDirectory())
  .sort();
let ran = 0;
for (const name of packageDirs) {
  const packageRoot = join(root, "packages", name);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const packageScript = manifest.scripts?.[scriptName];
  if (!packageScript) {
    if (requireProcessedFiles) throw new Error(`${manifest.name} has no ${scriptName} script`);
    continue;
  }
  if (requireProcessedFiles && scriptName === "lint") {
    if (packageScript.includes("--no-errors-on-unmatched")) {
      throw new Error(`${manifest.name} lint disables unmatched-file errors`);
    }
    if (sourceFileCount(packageRoot) === 0) throw new Error(`${manifest.name} has no source files to lint`);
  }
  ran += 1;
  console.log(`\n== ${manifest.name} :: ${scriptName} ==`);
  const packageArgs = forwardedArgs.filter(
    (arg) => !(arg === "--error-on-warnings" && packageScript.includes("--error-on-warnings")),
  );
  const result = spawnSync("bun", ["run", scriptName, ...packageArgs], {
    cwd: packageRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (requireProcessedFiles && scriptName === "lint") {
    const checked = [...output.matchAll(/\bChecked\s+(\d+)\s+files?\b/g)].reduce(
      (total, match) => total + Number(match[1]),
      0,
    );
    if (!Number.isInteger(checked) || checked < 1) {
      throw new Error(`${manifest.name} lint did not report any processed source files`);
    }
    console.log(`lint-inventory: ${manifest.name}: ${checked} file(s) processed`);
  }
}
if (requireProcessedFiles && ran === 0) throw new Error(`no packages ran ${scriptName}`);
console.log(`run-package-scripts: ${scriptName}: ${ran} package(s)`);
