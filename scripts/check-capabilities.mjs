import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const capabilitiesPath = resolve(root, "packages/pi-workflows/src/capabilities.ts");
const packagePath = resolve(root, "packages/pi-workflows/package.json");
const readmePath = resolve(root, "packages/pi-workflows/README.md");
const indexPath = resolve(root, "packages/pi-workflows/skills/workflow-authoring/references/capabilities.md");
const detailsPath = resolve(root, "packages/pi-workflows/skills/workflow-authoring/references/capability-details.md");
const skillPaths = [
  resolve(root, "packages/pi-workflows/skills/workflow-authoring/SKILL.md"),
  resolve(root, "packages/pi-workflows/skills/workflow-patterns/SKILL.md"),
  resolve(root, "packages/pi-workflows/skills/workflow-review/SKILL.md"),
];

const source = readFileSync(capabilitiesPath, "utf8");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const readme = readFileSync(readmePath, "utf8");
const contractVersion = /WORKFLOW_CAPABILITY_CONTRACT_VERSION\s*=\s*"([^"]+)"/u.exec(source)?.[1];
if (!contractVersion) throw new Error("check:capabilities: contract version is missing");

function readCapabilityArray() {
  const declaration = source.indexOf("export const WORKFLOW_CAPABILITIES");
  const open = source.indexOf("[", declaration);
  const close = source.indexOf("\n];\n\n/**", open);
  if (declaration < 0 || open < 0 || close < 0) {
    throw new Error("check:capabilities: could not locate WORKFLOW_CAPABILITIES literal");
  }
  // The declaration is intentionally a literal-only array. Evaluate it in an
  // empty VM realm so this check reads the same structured contract the source
  // exports without importing TypeScript or executing package initialization.
  const value = vm.runInNewContext(`(${source.slice(open, close + 2)})`, Object.create(null));
  if (!Array.isArray(value) || value.length === 0) throw new Error("check:capabilities: capability contract is empty");
  return value;
}

const capabilities = readCapabilityArray();
const readmeLower = readme.toLowerCase();
const missingReadme = capabilities
  .map((entry) => String(entry.name))
  .filter((name) => !readmeLower.includes(name.toLowerCase()))
  .filter(
    (name) =>
      ![
        "export const meta",
        "determinism",
        "script",
        "name",
        "args",
        "background",
        "maxAgents",
        "concurrency",
        "agentRetries",
        "agentTimeoutMs",
        "tokenBudget",
        "resumeFromRunId",
        "console",
      ].includes(name),
  );
if (missingReadme.length > 0) {
  throw new Error(`check:capabilities: capabilities not mentioned in README: ${missingReadme.join(", ")}`);
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function optionText(option) {
  const optional = option.optional ? " (optional)" : "";
  const defaultText = option.default && option.default !== "none" ? `; default: ${option.default}` : "";
  return `\`${markdownCell(option.name)}\`: ${markdownCell(option.kind)}${optional}${markdownCell(defaultText)}`;
}

function entryKey(entry) {
  return `${entry.classification}-${entry.name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function renderIndex() {
  const rows = capabilities.map((entry) => {
    const options = entry.options.length > 0 ? entry.options.map(optionText).join("<br>") : "—";
    return `| ${markdownCell(entry.name)} | ${markdownCell(entry.classification)} | \`${markdownCell(entry.signature)}\` | ${options} |`;
  });
  return [
    "<!-- GENERATED from WORKFLOW_CAPABILITY_CONTRACT; do not edit by hand. -->",
    "# Workflow capability index",
    "",
    `Contract format: \`${contractVersion}\`<br>`,
    `Contract content / skill / extension: \`${packageJson.version}\``,
    "",
    "This compact generated index covers supported runtime globals and workflow-tool inputs. For constraints, compatibility behavior, internal boundaries, and dynamic-reference ownership, follow the [exhaustive generated facts](capability-details.md).",
    "",
    "## Supported capability index",
    "",
    "<!-- BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES -->",
    "| Name | Classification | Signature | Options and defaults |",
    "| --- | --- | --- | --- |",
    ...rows,
    "<!-- END GENERATED SUPPORTED WORKFLOW CAPABILITIES -->",
    "",
  ].join("\n");
}

function renderDetails() {
  const sections = capabilities.map((entry) => {
    const options = entry.options.map(optionText);
    const constraints = entry.constraints.map((constraint) => `- Constraint: ${markdownCell(constraint)}`);
    return [
      `<a id="${entryKey(entry)}"></a>`,
      `## ${markdownCell(entry.name)}`,
      "",
      `- Classification: \`${markdownCell(entry.classification)}\``,
      "- Support: `supported`",
      `- Signature: \`${markdownCell(entry.signature)}\``,
      ...options.map((option) => `- ${option}`),
      ...constraints,
      "",
    ].join("\n");
  });
  return [
    "<!-- GENERATED from WORKFLOW_CAPABILITY_CONTRACT; do not edit by hand. -->",
    "# Exhaustive workflow capability facts",
    "",
    `Contract format: \`${contractVersion}\`<br>`,
    `Contract content / skill / extension: \`${packageJson.version}\``,
    "",
    "Every exact fact below is projected from the installed extension's capability contract. Explanatory judgment belongs in the hand-written references next to this file.",
    "",
    "<!-- BEGIN GENERATED WORKFLOW CAPABILITY FACTS -->",
    ...sections,
    "<!-- END GENERATED WORKFLOW CAPABILITY FACTS -->",
    "",
  ].join("\n");
}

function skillVersion(source, skillPath) {
  const version = /^ {2}version: "([^"]+)"$/mu.exec(source)?.[1];
  if (!version) throw new Error(`check:capabilities: skill metadata version is missing: ${skillPath}`);
  return version;
}

function writeSkillVersion(skillPath) {
  const source = readFileSync(skillPath, "utf8");
  skillVersion(source, skillPath);
  writeFileSync(skillPath, source.replace(/^ {2}version: "[^"]+"$/mu, `  version: "${packageJson.version}"`), "utf8");
}

const expectedIndex = renderIndex();
const expectedDetails = renderDetails();
if (process.argv.includes("--write")) {
  writeFileSync(indexPath, expectedIndex, "utf8");
  writeFileSync(detailsPath, expectedDetails, "utf8");
  for (const skillPath of skillPaths) writeSkillVersion(skillPath);
} else {
  const actualIndex = readFileSync(indexPath, "utf8");
  const actualDetails = readFileSync(detailsPath, "utf8");
  const stale = [];
  if (actualIndex !== expectedIndex) stale.push(indexPath);
  if (actualDetails !== expectedDetails) stale.push(detailsPath);
  for (const skillPath of skillPaths) {
    if (skillVersion(readFileSync(skillPath, "utf8"), skillPath) !== packageJson.version) stale.push(skillPath);
  }
  if (stale.length > 0) {
    throw new Error(
      `check:capabilities: generated capability docs or skill versions are stale; run node scripts/check-capabilities.mjs --write (${stale.join(", ")})`,
    );
  }
}

console.log(`check:capabilities: ${capabilities.length} capabilities declared and generated docs are exact`);
