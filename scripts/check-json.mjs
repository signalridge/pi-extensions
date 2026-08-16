import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
let count = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules" || name === "dist" || name === "coverage") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (name.endsWith(".json")) {
      JSON.parse(readFileSync(path, "utf8"));
      count += 1;
    }
  }
}
walk(root);
console.log(`check-json: ${count} JSON files`);
