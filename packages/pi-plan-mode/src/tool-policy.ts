import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const BUILTIN_SAFE_GIT_SUBCOMMANDS = [
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "ls-files",
  "grep",
] as const;
export const CONFIGURABLE_SAFE_GIT_SUBCOMMANDS = [
  "rev-parse",
  "blame",
  "describe",
  "merge-base",
  "ls-tree",
  "cat-file",
] as const;
export const SAFE_GIT_SUBCOMMANDS = [...BUILTIN_SAFE_GIT_SUBCOMMANDS, ...CONFIGURABLE_SAFE_GIT_SUBCOMMANDS] as const;
export const SAFE_GH_SUBCOMMAND_PATHS = ["pr view", "pr list", "issue view", "issue list"] as const;

export type BuiltinSafeGitSubcommand = (typeof BUILTIN_SAFE_GIT_SUBCOMMANDS)[number];
export type ConfigurableSafeGitSubcommand = (typeof CONFIGURABLE_SAFE_GIT_SUBCOMMANDS)[number];
export type SafeGitSubcommand = (typeof SAFE_GIT_SUBCOMMANDS)[number];
export type SafeGhSubcommandPath = (typeof SAFE_GH_SUBCOMMAND_PATHS)[number];
export interface SafeSubcommands {
  git?: SafeGitSubcommand[];
  gh?: SafeGhSubcommandPath[];
}

export const SAFE_BUILTIN_PLAN_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
export type PlanModeToolPolicy = "read-only" | "limited" | "user-opt-in" | "blocked";

const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write"]);
const MUTATING_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "tee",
  "truncate",
  "dd",
  "sudo",
  "su",
  "kill",
  "pkill",
  "killall",
  "reboot",
  "shutdown",
  "vim",
  "vi",
  "nano",
  "emacs",
  "code",
  "subl",
]);

// These are deliberately ordinary inspection programs only. Project scripts,
// interpreters, build tools, and test runners are not safe merely because a
// particular repository currently defines them as read-only.
const READ_ONLY_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "find",
  "ls",
  "pwd",
  "echo",
  "printf",
  "wc",
  "sort",
  "uniq",
  "diff",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "which",
  "whereis",
  "type",
  "printenv",
  "uname",
  "whoami",
  "id",
  "date",
  "uptime",
  "ps",
  "jq",
  "rg",
  "fd",
  "sed",
]);

export function isBuiltinTool(tool: ToolInfo) {
  return tool.sourceInfo.source === "builtin";
}

export function classifyPlanModeTool(tool: ToolInfo): PlanModeToolPolicy {
  if (!isBuiltinTool(tool)) return "user-opt-in";
  if (BLOCKED_BUILTIN_TOOLS.has(tool.name)) return "blocked";
  if (tool.name === "bash") return "limited";
  return SAFE_BUILTIN_PLAN_TOOLS.has(tool.name) ? "read-only" : "blocked";
}

export function canSelectToolInPlanMode(tool: ToolInfo) {
  return classifyPlanModeTool(tool) !== "blocked";
}

export function readCommand(input: unknown) {
  const command = input as { command?: unknown } | undefined;
  return typeof command?.command === "string" ? command.command : "";
}

/**
 * Plan mode accepts one parsed argv inspection command. It intentionally does
 * not accept a shell program: command lists, pipelines, redirects, and
 * substitutions are all rejected before any command-specific validator runs.
 */
export function findBlockedCommandSegment(command: string, safeSubcommands: SafeSubcommands = {}): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return "(empty command)";
  const tokens = shellWords(trimmed);
  if (!tokens || !isSafeTokens(tokens)) return trimmed;
  return isSafeArgv(tokens, safeSubcommands) ? undefined : trimmed;
}

export function isSafeCommand(command: string, safeSubcommands: SafeSubcommands = {}) {
  return findBlockedCommandSegment(command, safeSubcommands) === undefined;
}

function isSafeArgv(tokens: string[], safeSubcommands: SafeSubcommands): boolean {
  const command = tokens[0]?.toLowerCase();
  if (!command || command !== tokens[0] || MUTATING_COMMANDS.has(command)) return false;
  const args = tokens.slice(1);
  if (/[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) return false;
  if (tokens.some((token) => /(^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(token))) return false;
  if (READ_ONLY_COMMANDS.has(command)) return isSafeInspectionCommand(command, args);
  if (command === "git") return isSafeGitCommand(args, safeSubcommands);
  if (command === "gh") return isSafeGhCommand(args, safeSubcommands);
  return false;
}

function isSafeTokens(tokens: readonly string[]): boolean {
  return tokens.every((token) => token.length > 0 && isSafeToken(token));
}

/** Reject shell syntax and expansion even when it is hidden in a quoted word. */
function isSafeToken(token: string): boolean {
  return (
    !token.includes("\0") &&
    ![...token].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    }) &&
    !token.startsWith("~") &&
    !/[|;&<>`()$*?{}]/u.test(token) &&
    !token.includes("[") &&
    !token.includes("]")
  );
}

/**
 * A small shell-word reader is used only to support quoted paths and spaces;
 * it is not a shell parser and never returns command separators.
 */
function shellWords(command: string): string[] | undefined {
  if (!command || /[\n\r]/u.test(command)) return undefined;
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let hasWord = false;

  const flush = () => {
    if (!hasWord) return false;
    words.push(word);
    word = "";
    hasWord = false;
    return true;
  };

  for (const character of command) {
    if (escaped) {
      word += character;
      hasWord = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      hasWord = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else {
        word += character;
        hasWord = true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      hasWord = true;
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    // No shell operators are allowed, including a harmless-looking pipeline
    // whose later command might mutate the project.
    if (/[|;&<>`()]/u.test(character)) return undefined;
    word += character;
    hasWord = true;
  }
  if (quote || escaped) return undefined;
  flush();
  return words.length > 0 ? words : undefined;
}

function isSafeInspectionCommand(command: string, args: string[]): boolean {
  switch (command) {
    case "pwd":
    case "whoami":
    case "uptime":
    case "printenv":
    case "id":
    case "df":
      return args.length === 0;
    case "date":
      return args.length === 0 || (args.length === 1 && /^\+[A-Za-z%:._-]+$/u.test(args[0] ?? ""));
    case "uname":
      return args.every((argument) => /^-[asnrvmpio]+$/u.test(argument));
    case "echo":
    case "printf":
      return args.length > 0 && args.every(isSafeToken);
    case "cat":
      return isPathCommand(args, new Set(["-n", "-b", "-s", "-A", "-E", "-T", "-v"]), 1);
    case "head":
    case "tail":
      return isHeadTailArguments(args);
    case "ls":
      return isPathCommand(args, new Set(["-a", "-A", "-l", "-h", "-1", "-R", "-d", "-F"]), 0);
    case "grep":
      return isSearchArguments(
        args,
        new Set(["-n", "-i", "-v", "-E", "-F", "-w", "-x", "-c", "-l", "-L", "-H", "-h", "-r", "-R", "-o"]),
      );
    case "rg":
      return isSearchArguments(
        args,
        new Set([
          "-n",
          "--line-number",
          "-i",
          "--ignore-case",
          "-v",
          "--invert-match",
          "-F",
          "--fixed-strings",
          "-w",
          "--word-regexp",
          "-x",
          "--files-with-matches",
          "-l",
          "--files",
          "-g",
          "--glob",
        ]),
      );
    case "fd":
      return (
        isPathCommand(args, new Set(["-H", "--hidden", "-t", "--type", "-d", "--max-depth"]), 0) &&
        !args.some((argument) => ["-x", "-X", "--exec", "--exec-batch"].includes(argument))
      );
    case "find":
      return isFindArguments(args);
    case "wc":
      return isPathCommand(args, new Set(["-c", "-m", "-l", "-w"]), 1);
    case "sort":
      return isSortArguments(args);
    case "uniq":
      return (
        isPathCommand(args, new Set(["-c", "-d", "-u", "-i"]), 0) && args.filter((a) => !a.startsWith("-")).length <= 1
      );
    case "diff":
      return isDiffArguments(args);
    case "file":
      return isPathCommand(args, new Set(["-b", "-L", "--brief", "--dereference"]), 1);
    case "stat":
      return isPathCommand(args, new Set(), 1);
    case "du":
      return isPathCommand(args, new Set(["-a", "-h", "-k", "-m", "-s", "--apparent-size"]), 0);
    case "tree":
      return isPathCommand(args, new Set(["-a", "-d", "-L", "-f", "-h"]), 0);
    case "which":
    case "whereis":
    case "type":
      return args.length > 0 && args.every((argument) => !argument.startsWith("-") && isSafeToken(argument));
    case "ps":
      return args.every((argument) => /^[A-Za-z-]+$/u.test(argument) || /^-[A-Za-z]+$/u.test(argument));
    case "jq":
      return isJqArguments(args);
    case "sed":
      return isReadOnlySed(args);
    default:
      return false;
  }
}

function isPathCommand(args: string[], flags: ReadonlySet<string>, minimumPaths: number): boolean {
  let afterEnd = false;
  let paths = 0;
  for (const argument of args) {
    if (!isSafeToken(argument)) return false;
    if (!afterEnd && argument === "--") {
      afterEnd = true;
      continue;
    }
    if (!afterEnd && argument.startsWith("-")) {
      if (!flags.has(argument)) return false;
      continue;
    }
    paths++;
  }
  return paths >= minimumPaths;
}

function isHeadTailArguments(args: string[]): boolean {
  let paths = 0;
  let valuePending = false;
  for (const argument of args) {
    if (!isSafeToken(argument)) return false;
    if (valuePending) {
      if (!/^\d+$/u.test(argument)) return false;
      valuePending = false;
      continue;
    }
    if (argument === "-n" || argument === "-c") {
      valuePending = true;
      continue;
    }
    if (/^(?:-n|-c)\d+$/u.test(argument) || /^--(?:lines|bytes)=\d+$/u.test(argument)) continue;
    if (argument.startsWith("-")) return false;
    paths++;
  }
  return !valuePending && paths > 0;
}

function isSearchArguments(args: string[], flags: ReadonlySet<string>): boolean {
  let operands = 0;
  let valuePending = false;
  let afterEnd = false;
  for (const argument of args) {
    if (!isSafeToken(argument)) return false;
    if (valuePending) {
      if (argument.startsWith("-") && argument !== "-") return false;
      valuePending = false;
      operands++;
      continue;
    }
    if (!afterEnd && argument === "--") {
      afterEnd = true;
      continue;
    }
    if (!afterEnd && argument === "-e") {
      valuePending = true;
      continue;
    }
    if (!afterEnd && argument.startsWith("--glob=")) continue;
    if (!afterEnd && argument.startsWith("-")) {
      if (!flags.has(argument)) return false;
      if (argument === "-g" || argument === "--glob") valuePending = true;
      continue;
    }
    operands++;
  }
  return !valuePending && operands >= 1;
}

function isFindArguments(args: string[]): boolean {
  if (args.length === 0) return false;
  let index = 0;
  if (!args[0]?.startsWith("-")) index = 1;
  else return false;
  while (index < args.length) {
    const argument = args[index];
    if (!argument || !isSafeToken(argument)) return false;
    if (argument === "--") return index === args.length - 1;
    if (
      argument === "-maxdepth" ||
      argument === "-mindepth" ||
      argument === "-name" ||
      argument === "-path" ||
      argument === "-type"
    ) {
      const value = args[index + 1];
      if (!value || !isSafeToken(value)) return false;
      if ((argument === "-maxdepth" || argument === "-mindepth") && !/^\d+$/u.test(value)) return false;
      if (argument === "-type" && !/^[fdl]$/u.test(value)) return false;
      index += 2;
      continue;
    }
    if (argument === "-print") {
      index++;
      continue;
    }
    return false;
  }
  return true;
}

function isSortArguments(args: string[]): boolean {
  let paths = 0;
  for (const argument of args) {
    if (!isSafeToken(argument)) return false;
    if (argument === "--") continue;
    if (argument.startsWith("-")) {
      if (/^-o(?:$|\S)|^-T(?:$|\S)/u.test(argument)) return false;
      if (!/^-(?:[bdfinruMcz]+|k\d+(?:,\d+)?|t\s*)$/u.test(argument)) return false;
      continue;
    }
    paths++;
  }
  return paths > 0;
}

function isDiffArguments(args: string[]): boolean {
  let paths = 0;
  for (const argument of args) {
    if (!isSafeToken(argument)) return false;
    if (
      argument === "--check" ||
      argument === "--stat" ||
      argument === "--shortstat" ||
      argument === "--name-only" ||
      argument === "--name-status" ||
      argument === "--no-ext-diff" ||
      argument === "--no-textconv" ||
      argument === "-q" ||
      argument === "-u" ||
      /^-U\d+$/u.test(argument) ||
      /^--unified=\d+$/u.test(argument)
    )
      continue;
    if (argument === "--") {
      paths++;
      continue;
    }
    if (argument.startsWith("-")) return false;
    paths++;
  }
  return paths >= 2;
}

function isJqArguments(args: string[]): boolean {
  const flags = new Set(["-c", "-e", "-M", "-R", "-r", "-s", "-S", "-n"]);
  let operands = 0;
  for (const argument of args) {
    if (!isSafeToken(argument)) return false;
    if (flags.has(argument)) continue;
    if (argument.startsWith("-")) return false;
    operands++;
  }
  return operands >= 1;
}

function isReadOnlySed(args: string[]): boolean {
  if (args.length < 3) return false;
  const script = args[args[0] === "-n" ? 1 : -1];
  if (args[0] !== "-n" || !script || !/^\d+(?:,\d+)?p$/u.test(script)) return false;
  return (
    args.slice(2).length > 0 && args.slice(2).every((argument) => !argument.startsWith("-") && isSafeToken(argument))
  );
}

type ArgumentValidator = (args: string[], globalOptions?: ReadonlySet<string>) => boolean;
const BUILTIN_GIT_VALIDATORS: Record<BuiltinSafeGitSubcommand, ArgumentValidator> = {
  status: (args, globalOptions) =>
    globalOptions?.has("--no-optional-locks") === true &&
    isGitInspectionArguments(
      args,
      new Set(["--short", "--porcelain", "--branch", "--untracked-files=no", "--ignored=no"]),
    ),
  log: (args) =>
    requiresGitDiffIsolation(args, false) &&
    isGitInspectionArguments(
      args,
      new Set([
        "-p",
        "--patch",
        "--stat",
        "--binary",
        "--patch-with-stat",
        "--oneline",
        "--no-decorate",
        "--all",
        "--no-merges",
        "--first-parent",
        "--no-textconv",
        "--no-ext-diff",
      ]),
      true,
    ),
  diff: (args) =>
    hasGitOptionBeforeEnd(args, "--no-ext-diff") &&
    hasGitOptionBeforeEnd(args, "--no-textconv") &&
    isGitInspectionArguments(
      args,
      new Set([
        "--cached",
        "--staged",
        "--check",
        "--stat",
        "--shortstat",
        "--name-only",
        "--name-status",
        "--no-ext-diff",
        "--no-textconv",
        "-q",
        "-u",
      ]),
      true,
    ),
  show: (args) =>
    requiresGitDiffIsolation(args, true) &&
    isGitInspectionArguments(
      args,
      new Set(["--stat", "--oneline", "--no-patch", "--no-ext-diff", "--no-textconv"]),
      true,
    ),
  branch: isSafeGitBranchArguments,
  remote: isSafeGitRemoteArguments,
  "ls-files": (args) =>
    isGitInspectionArguments(
      args,
      new Set(["--cached", "--deleted", "--modified", "--others", "--ignored", "--stage", "-v", "-z"]),
    ),
  grep: (args) =>
    isGitInspectionArguments(
      args,
      new Set(["-n", "-i", "-v", "-w", "-e", "--no-textconv", "--full-name", "--line-number"]),
      true,
    ),
};
const CONFIGURABLE_GIT_VALIDATORS: Record<ConfigurableSafeGitSubcommand, ArgumentValidator> = {
  "rev-parse": (args) =>
    isGitInspectionArguments(
      args,
      new Set([
        "--show-toplevel",
        "--show-prefix",
        "--is-inside-work-tree",
        "--is-inside-git-dir",
        "--verify",
        "--short",
        "--abbrev-ref",
      ]),
      true,
    ),
  blame: (args) => isGitInspectionArguments(args, new Set(["--no-textconv", "--line-porcelain", "-L"]), true),
  describe: (args) =>
    isGitInspectionArguments(args, new Set(["--always", "--tags", "--all", "--long", "--dirty"]), true),
  "merge-base": (args) => isGitInspectionArguments(args, new Set(), true),
  "ls-tree": (args) =>
    isGitInspectionArguments(args, new Set(["-r", "-d", "-t", "--name-only", "--full-tree", "--long"]), true),
  "cat-file": (args) => isGitInspectionArguments(args, new Set(["-p", "-t", "-s", "--batch-check"]), true),
};
const GH_VALIDATORS: Record<SafeGhSubcommandPath, ArgumentValidator> = {
  "pr view": isSafeGhReadArguments,
  "pr list": isSafeGhReadArguments,
  "issue view": isSafeGhReadArguments,
  "issue list": isSafeGhReadArguments,
};

function isSafeGitCommand(args: string[], safeSubcommands: SafeSubcommands): boolean {
  let subcommandIndex = 0;
  const globalOptions = new Set<string>();
  while (args[subcommandIndex] === "--no-pager" || args[subcommandIndex] === "--no-optional-locks") {
    globalOptions.add(args[subcommandIndex]);
    subcommandIndex++;
  }
  const subcommand = args[subcommandIndex]?.toLowerCase();
  if (!subcommand || subcommand !== args[subcommandIndex] || subcommand.startsWith("-")) return false;
  const subcommandArgs = args.slice(subcommandIndex + 1);
  const builtinValidator = (BUILTIN_GIT_VALIDATORS as Record<string, ArgumentValidator>)[subcommand];
  const configuredValidator = (CONFIGURABLE_GIT_VALIDATORS as Record<string, ArgumentValidator>)[subcommand];
  const configured = safeSubcommands.git?.includes(subcommand as SafeGitSubcommand) === true;
  const validator = builtinValidator ?? (configured ? configuredValidator : undefined);
  return (
    validator !== undefined &&
    hasSafeGitArguments(subcommand, subcommandArgs) &&
    validator(subcommandArgs, globalOptions)
  );
}

function hasSafeGitArguments(subcommand: string, args: string[]): boolean {
  return !args.some((argument) => {
    const option = argument.split("=", 1)[0] ?? "";
    return (
      option === "--help" ||
      option === "--paginate" ||
      option === "--pager" ||
      option === "--open-files-in-pager" ||
      option === "--ext-diff" ||
      option === "--textconv" ||
      option === "--filters" ||
      option === "--filter" ||
      option === "--ext-grep" ||
      option === "--output" ||
      option === "--config" ||
      option === "--exec-path" ||
      option.includes("%G") ||
      (subcommand === "grep" && (option === "-O" || option.startsWith("-O"))) ||
      (subcommand === "branch" && /^-[^-]*[dDmMcCu]/u.test(argument))
    );
  });
}

function hasGitOptionBeforeEnd(args: string[], option: string): boolean {
  for (const argument of args) {
    if (argument === "--") return false;
    if (argument === option) return true;
  }
  return false;
}

function requiresGitDiffIsolation(args: string[], defaultProducesDiff: boolean): boolean {
  let producesDiff = defaultProducesDiff;
  for (const argument of args) {
    if (argument === "--") break;
    const option = argument.split("=", 1)[0] ?? "";
    if (option === "--no-patch") {
      producesDiff = false;
    } else if (
      option === "-p" ||
      option === "--patch" ||
      option === "--binary" ||
      option === "--patch-with-stat" ||
      /^-U\d+$/u.test(argument)
    ) {
      // Git's patch/context options can re-enable a patch after --no-patch;
      // evaluate them in argv order instead of treating any --no-patch as final.
      producesDiff = true;
    }
  }
  if (!producesDiff) return true;
  return hasGitOptionBeforeEnd(args, "--no-ext-diff") && hasGitOptionBeforeEnd(args, "--no-textconv");
}

function isGitInspectionArguments(args: string[], flags: ReadonlySet<string>, allowOperands = false): boolean {
  let operands = 0;
  let afterEnd = false;
  for (const argument of args) {
    if (!isSafeToken(argument)) return false;
    if (!afterEnd && argument === "--") {
      afterEnd = true;
      continue;
    }
    if (!afterEnd && argument.startsWith("-")) {
      if (
        flags.has(argument) ||
        /^-\d+$/u.test(argument) ||
        /^-U\d+$/u.test(argument) ||
        /^-[SG].+$/u.test(argument) ||
        /^--find-object=[0-9a-fA-F]{7,64}$/u.test(argument) ||
        (/^--(?:format|pretty)=.+$/u.test(argument) && !argument.includes("%G"))
      )
        continue;
      if (argument === "-e" || argument === "-L") continue;
      return false;
    }
    operands++;
  }
  return allowOperands || operands === 0;
}

function isSafeGitBranchArguments(args: string[]): boolean {
  const allowed = new Set(["--show-current", "--list", "--all", "--remotes", "-a", "-r", "-v", "-vv"]);
  const valueOptions = new Set(["--contains", "--merged", "--no-merged"]);
  let pendingValue = false;
  for (const argument of args) {
    if (!isSafeToken(argument)) return false;
    if (pendingValue) {
      if (argument.startsWith("-")) return false;
      pendingValue = false;
      continue;
    }
    const option = argument.split("=", 1)[0] ?? "";
    if (valueOptions.has(option)) {
      if (argument.startsWith(`${option}=`)) {
        const value = argument.slice(option.length + 1);
        if (!value || value.startsWith("-") || !isSafeToken(value)) return false;
      } else {
        pendingValue = true;
      }
      continue;
    }
    if (allowed.has(argument)) continue;
    return false;
  }
  return !pendingValue;
}

function isSafeGitRemoteArguments(args: string[]): boolean {
  if (args.length === 0) return true;
  if (args[0] === "-v" || args[0] === "--verbose") return args.length <= 1;
  const action = args[0];
  if (action === "get-url")
    return args.length >= 2 && args.slice(1).every((argument) => isSafeToken(argument) && !argument.startsWith("-"));
  if (action === "show") {
    return (
      args[1] === "-n" &&
      (args.length === 2 || (args.length === 3 && isSafeToken(args[2] ?? "") && !args[2]?.startsWith("-")))
    );
  }
  return false;
}

function isSafeGhCommand(args: string[], safeSubcommands: SafeSubcommands) {
  const group = args[0]?.toLowerCase();
  const action = args[1]?.toLowerCase();
  if (!group || !action || group !== args[0] || action !== args[1] || group.startsWith("-") || action.startsWith("-"))
    return false;
  const path = `${group} ${action}` as SafeGhSubcommandPath;
  if (!safeSubcommands.gh?.includes(path)) return false;
  const validator = (GH_VALIDATORS as Record<string, ArgumentValidator>)[path];
  return validator?.(args.slice(2)) ?? false;
}

function isSafeGhReadArguments(args: string[]) {
  let hasJson = false;
  let pending: "json" | "limit" | "state" | "jq" | undefined;
  for (const argument of args) {
    if (!isSafeToken(argument)) return false;
    if (pending) {
      if (argument.startsWith("-")) return false;
      if (pending === "json" && !/^[A-Za-z][A-Za-z0-9_,.-]*$/u.test(argument)) return false;
      if (pending === "limit" && !/^\d+$/u.test(argument)) return false;
      if (pending === "state" && !/^(?:open|closed|merged|all)$/u.test(argument)) return false;
      pending = undefined;
      continue;
    }
    if (argument === "--json") {
      pending = "json";
      hasJson = true;
      continue;
    }
    if (argument.startsWith("--json=")) {
      if (!/^--json=[A-Za-z][A-Za-z0-9_,.-]*$/u.test(argument)) return false;
      hasJson = true;
      continue;
    }
    if (argument === "--limit") {
      pending = "limit";
      continue;
    }
    if (argument === "--state") {
      pending = "state";
      continue;
    }
    if (argument === "--jq") {
      pending = "jq";
      continue;
    }
    if (argument.startsWith("--jq=")) continue;
    if (
      [
        "--comments",
        "--reviewer",
        "--author",
        "--assignee",
        "--label",
        "--mention",
        "--head",
        "--base",
        "--draft",
        "--merged",
        "--closed",
        "--search",
      ].includes(argument)
    ) {
      pending = argument === "--search" ? "jq" : pending;
      continue;
    }
    if (argument.startsWith("-")) return false;
  }
  return pending === undefined && hasJson;
}
