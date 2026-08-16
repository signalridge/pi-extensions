import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const REQUIRED_SCRIPTS = ["lint", "typecheck", "test", "check", "format"];
const PACKAGE_DIRECTORY_PATTERN = /^pi-.+$/u;
const PACKAGE_NAME_PATTERN = /^@signalridge\/pi-.+$/u;

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireNonEmptyScript(manifest, directory, name) {
  const command = manifest.scripts?.[name];
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error(`packages/${directory} needs a non-empty ${name} script`);
  }
  return command;
}

function referencesPackageScript(command, name) {
  // Package checks intentionally use the repository's existing `bun run` or
  // `npm run` convention. Match a complete script name, not incidental words
  // in package-specific flags or test file paths.
  return new RegExp(`\\b(?:bun|npm)\\s+run\\s+${name}(?=\\s|$|&&|;)`, "u").test(command);
}

function referencesQualityPhase(command, phase) {
  if (phase === "lint" && /\bbiome\s+(?:check|lint)\b/u.test(command)) return true;
  return referencesPackageScript(command, phase);
}

function validateExtensionEntries(directory, packageRoot, manifest) {
  const entries = manifest.pi?.extensions;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`packages/${directory} pi.extensions must be non-empty`);
  }
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.startsWith("./")) {
      throw new Error(`packages/${directory} pi.extensions entries must be package-relative files: ${String(entry)}`);
    }
    const absolute = resolve(packageRoot, entry);
    const packageRelative = relative(packageRoot, absolute).split(sep).join("/");
    if (packageRelative === ".." || packageRelative.startsWith("../") || !isFile(absolute)) {
      throw new Error(`packages/${directory} has an invalid local extension entry: ${entry}`);
    }
    if (seen.has(packageRelative)) {
      throw new Error(`packages/${directory} pi.extensions contains duplicate entry: ${entry}`);
    }
    seen.add(packageRelative);
  }
}

export function validatePackageManifest(directory, packageRoot, manifest) {
  if (!PACKAGE_DIRECTORY_PATTERN.test(directory)) {
    throw new Error(`packages/${directory} must use a pi-* directory name`);
  }
  if (!PACKAGE_NAME_PATTERN.test(manifest.name) || manifest.name !== `@signalridge/${directory}`) {
    throw new Error(`packages/${directory} must use a matching @signalridge/pi-* package name`);
  }
  if (manifest.private === true) {
    throw new Error(`packages/${directory} must remain publishable (private=false)`);
  }
  if (manifest.type !== "module") {
    throw new Error(`packages/${directory} must be an ES module (type: module)`);
  }
  if (manifest.publishConfig?.access !== "public") {
    throw new Error(`packages/${directory} must set publishConfig.access to public`);
  }
  if (manifest.repository?.directory !== `packages/${directory}`) {
    throw new Error(`packages/${directory} repository.directory must be packages/${directory}`);
  }
  const isLibrary = manifest.signalridgePackage?.kind === "library";
  if (
    !isLibrary &&
    manifest.piExtension?.lifecycle !== "stable" &&
    manifest.piExtension?.lifecycle !== "experimental"
  ) {
    throw new Error(`packages/${directory} must declare lifecycle stable or experimental`);
  }
  if (!isLibrary) validateExtensionEntries(directory, packageRoot, manifest);

  for (const file of ["tsconfig.json", "README.md", "LICENSE", "CHANGELOG.md"]) {
    if (!isFile(resolve(packageRoot, file))) {
      throw new Error(`packages/${directory} needs ${file}`);
    }
  }
  if (!Array.isArray(manifest.files) || !manifest.files.includes("CHANGELOG.md")) {
    throw new Error(`packages/${directory} files must include CHANGELOG.md`);
  }

  const scripts = Object.fromEntries(
    REQUIRED_SCRIPTS.map((name) => [name, requireNonEmptyScript(manifest, directory, name)]),
  );
  for (const phase of ["lint", "typecheck", "test"]) {
    if (!referencesQualityPhase(scripts.check, phase)) {
      throw new Error(
        `packages/${directory} check script must run ${phase} (via a package script or Biome lint command)`,
      );
    }
  }
}

export function validatePackageConfig(root = REPOSITORY_ROOT) {
  const packagesRoot = resolve(root, "packages");
  if (!existsSync(packagesRoot) || !statSync(packagesRoot).isDirectory()) {
    throw new Error("packages/ directory is missing");
  }

  const directories = readdirSync(packagesRoot)
    .filter((name) => statSync(resolve(packagesRoot, name)).isDirectory())
    .sort();
  if (directories.length === 0) throw new Error("packages/ must contain at least one package");

  for (const directory of directories) {
    const packageRoot = resolve(packagesRoot, directory);
    const manifestPath = resolve(packageRoot, "package.json");
    if (!isFile(manifestPath)) throw new Error(`missing package manifest: packages/${directory}/package.json`);
    validatePackageManifest(directory, packageRoot, readManifest(manifestPath));
  }
  return directories.length;
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  const count = validatePackageConfig();
  console.log(`check-package-config: ${count} package manifests valid`);
}
