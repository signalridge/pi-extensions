/**
 * Diff discovery for the `/code-review` command.
 *
 * The `code-review` script reviews a diff it is handed; a user types a *scope*
 * (nothing, a PR number, a revision range, or a path). This module turns the
 * one into the other, and degrades to a plain `git diff HEAD` whenever the
 * narrower attempt fails or comes back empty — a review of nothing looks
 * identical to a review that found nothing, so silence is not an option.
 *
 * Commands are run as argv arrays, never as shell strings: a branch or path
 * argument is attacker-influenced often enough that interpolation is a real
 * injection surface.
 */

/** Result of one command: `ok` is false for a non-zero exit or a spawn failure. */
export interface CommandResult {
  ok: boolean;
  stdout: string;
}

/** Runs one command with an argv array. Injected so this module is testable without git. */
export type CommandRunner = (file: string, args: string[]) => CommandResult;

export interface CodeReviewScope {
  diff: string;
  /** Human-readable provenance, shown in the report and passed to the script. */
  diffSource: string;
  /** Degradation messages to surface with `ctx.ui.notify`; empty on the happy path. */
  notices: string[];
}

/** Diffs above this are truncated — the review agents have a finite context. */
export const MAX_DIFF_CHARS = 120_000;

/**
 * Pathspecs excluded from the no-argument auto scope.
 *
 * Deliberately limited to high-confidence generated or vendored output. A false
 * exclusion silently hides real changes from review, which is worse than the
 * noise it saves, so anything ambiguous is left in.
 */
export const AUTO_SCOPE_EXCLUSIONS: readonly string[] = [
  ":(exclude)**/node_modules/**",
  ":(exclude)**/dist/**",
  ":(exclude)**/build/**",
  ":(exclude)**/coverage/**",
  ":(exclude)**/.next/**",
  ":(exclude)**/__snapshots__/**",
  ":(exclude)**/*.min.js",
  ":(exclude)**/*.map",
  ":(exclude)**/package-lock.json",
  ":(exclude)**/bun.lock",
  ":(exclude)**/bun.lockb",
  ":(exclude)**/pnpm-lock.yaml",
  ":(exclude)**/yarn.lock",
  ":(exclude)**/Cargo.lock",
  ":(exclude)**/go.sum",
  ":(exclude)**/uv.lock",
  ":(exclude)**/poetry.lock",
];

function truncate(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= MAX_DIFF_CHARS) return { diff, truncated: false };
  return {
    diff: `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} characters]`,
    truncated: true,
  };
}

function finish(diff: string, diffSource: string, notices: string[]): CodeReviewScope {
  const capped = truncate(diff);
  if (capped.truncated) {
    notices.push(`Diff truncated at ${MAX_DIFF_CHARS} characters — review covers the first part only.`);
  }
  return { diff: capped.diff, diffSource, notices };
}

/**
 * Resolve the `/code-review` argument into a diff.
 *
 * - `""` → working tree against HEAD, generated artifacts excluded
 * - `"123"` → `gh pr diff 123`
 * - `"main..HEAD"` → that revision range
 * - anything else → treated as a path
 */
export function resolveCodeReviewScope(argument: string, run: CommandRunner): CodeReviewScope {
  const text = argument.trim();
  const notices: string[] = [];

  if (/^\d+$/u.test(text)) {
    const pr = run("gh", ["pr", "diff", text]);
    if (!pr.ok) {
      notices.push(`Could not read PR #${text} (is the gh CLI authenticated?). Nothing to review.`);
      return finish("", `PR #${text}`, notices);
    }
    return finish(pr.stdout, `PR #${text}`, notices);
  }

  if (text.includes("..")) {
    const range = run("git", ["diff", text]);
    if (!range.ok) {
      notices.push(`Could not diff range "${text}". Nothing to review.`);
      return finish("", `range ${text}`, notices);
    }
    return finish(range.stdout, `range ${text}`, notices);
  }

  if (text) {
    const scoped = run("git", ["diff", "HEAD", "--", text]);
    if (!scoped.ok) {
      notices.push(`Could not diff path "${text}". Nothing to review.`);
      return finish("", `path ${text}`, notices);
    }
    return finish(scoped.stdout, `path ${text}`, notices);
  }

  // No argument: auto scope, with the two documented degradations.
  const bare = () => run("git", ["diff", "HEAD"]);

  const auto = run("git", ["diff", "HEAD", "--", ".", ...AUTO_SCOPE_EXCLUSIONS]);
  if (!auto.ok) {
    const fallback = bare();
    notices.push("Auto-scoped diff failed; reviewing the full `git diff HEAD` instead.");
    if (!fallback.ok) {
      notices.push("`git diff HEAD` also failed — is this a git repository? Nothing to review.");
      return finish("", "working tree", notices);
    }
    return finish(fallback.stdout, "working tree (unscoped)", notices);
  }

  if (auto.stdout.trim()) return finish(auto.stdout, "working tree vs HEAD", notices);

  // The exclusions emptied the diff. Only fall back when there was in fact
  // something to review — an genuinely clean tree must not be reported as a
  // degradation.
  const fallback = bare();
  if (fallback.ok && fallback.stdout.trim()) {
    notices.push("Every change was an excluded generated artifact; reviewing the full `git diff HEAD` instead.");
    return finish(fallback.stdout, "working tree (unscoped)", notices);
  }

  notices.push("No uncommitted changes against HEAD — nothing to review.");
  return finish("", "working tree vs HEAD", notices);
}
