import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireSinglePackageSelection, runWithRateLimitRetry } from "./publish-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NPM_REGISTRY = "https://registry.npmjs.org/";
const PUBLISH_SCRIPT = "scripts/publish-packages.mjs";
const USAGE_MESSAGE =
  "usage: node scripts/publish-with-token.mjs <npm-token> [publish options] | --token-stdin [publish options] (requires exactly one package selection)";
const TOKEN_ERROR_MESSAGE = "npm token must be a non-empty string without whitespace";
const WRAPPER_ONLY_OPTION_PATTERN = /^--(?:token|npm-token|auth-token|npmrc|userconfig)(?:=|-|$)/iu;

class UsageError extends Error {}

function usageError(message = USAGE_MESSAGE) {
  return new UsageError(message);
}

export function validateToken(token) {
  if (typeof token !== "string" || token.length === 0 || /\s/u.test(token)) {
    throw usageError(TOKEN_ERROR_MESSAGE);
  }
  return token;
}

function rejectWrapperOnlyOptions(args) {
  if (args.some((arg) => WRAPPER_ONLY_OPTION_PATTERN.test(arg))) {
    throw usageError();
  }
}
function requireTokenPackageSelection(args) {
  try {
    return requireSinglePackageSelection(args, "token/bootstrap");
  } catch (error) {
    throw usageError(`${USAGE_MESSAGE}\n${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parsePublishWithTokenArgs(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) throw usageError();
  if (argv.length === 0) throw usageError();

  const [first, ...publishArgs] = argv;
  if (first === "--token-stdin") {
    rejectWrapperOnlyOptions(publishArgs);
    requireTokenPackageSelection(publishArgs);
    return { tokenSource: "stdin", publishArgs };
  }
  if (first.startsWith("-")) throw usageError();

  validateToken(first);
  rejectWrapperOnlyOptions(publishArgs);
  requireTokenPackageSelection(publishArgs);
  return { tokenSource: "argument", token: first, publishArgs };
}

export function buildNpmrc(token) {
  const validatedToken = validateToken(token);
  return `registry=${NPM_REGISTRY}\n//registry.npmjs.org/:_authToken=${validatedToken}\n`;
}

export function buildPublishCommandArgs(publishArgs) {
  if (!Array.isArray(publishArgs) || publishArgs.some((arg) => typeof arg !== "string")) throw usageError();
  return [PUBLISH_SCRIPT, "--bootstrap", ...publishArgs];
}

function readTokenFromStdin() {
  let input = readFileSync(0, "utf8");
  if (input.endsWith("\r\n")) input = input.slice(0, -2);
  else if (input.endsWith("\n")) input = input.slice(0, -1);
  return validateToken(input);
}

function makeTemporaryDirectory() {
  const temporaryRoot = resolve(tmpdir());
  const repositoryPrefix = `${root}${sep}`;
  if (temporaryRoot === root || temporaryRoot.startsWith(repositoryPrefix)) {
    throw new Error("temporary npm configuration must be outside the repository");
  }
  return mkdtempSync(join(temporaryRoot, "pi-publish-token-"));
}

function commandStatus(result) {
  return result.error || typeof result.status !== "number" ? 1 : result.status;
}

function writeCommandOutput(result) {
  if (typeof result.stdout === "string" && result.stdout.length > 0) process.stdout.write(result.stdout);
  if (typeof result.stderr === "string" && result.stderr.length > 0) process.stderr.write(result.stderr);
}

function runPublish(token, publishArgs) {
  const temporaryDirectory = makeTemporaryDirectory();
  try {
    chmodSync(temporaryDirectory, 0o700);
    const configPath = join(temporaryDirectory, ".npmrc");
    writeFileSync(configPath, buildNpmrc(token), { encoding: "utf8", mode: 0o600 });
    chmodSync(configPath, 0o600);

    const childEnv = { ...process.env, NPM_CONFIG_USERCONFIG: configPath };
    const whoami = runWithRateLimitRetry(
      "npm",
      ["whoami", `--registry=${NPM_REGISTRY}`],
      {
        cwd: root,
        env: childEnv,
        stdio: "pipe",
      },
      { onAttempt: writeCommandOutput },
    );
    if (whoami.error || whoami.status !== 0) {
      if (whoami.error) console.error("publish-with-token: could not run npm whoami");
      return commandStatus(whoami);
    }

    const publish = spawnSync(process.execPath, buildPublishCommandArgs(publishArgs), {
      cwd: root,
      env: childEnv,
      stdio: "inherit",
    });
    if (publish.error) console.error("publish-with-token: could not run the publish script");
    return commandStatus(publish);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function main() {
  const parsed = parsePublishWithTokenArgs();
  const token = parsed.tokenSource === "stdin" ? readTokenFromStdin() : parsed.token;
  return runPublish(token, parsed.publishArgs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof UsageError) console.error(error.message);
    else console.error("publish-with-token: operation failed");
    process.exitCode = 1;
  }
}

export { NPM_REGISTRY, PUBLISH_SCRIPT, USAGE_MESSAGE };
