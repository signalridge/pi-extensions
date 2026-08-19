/**
 * status.ts — `git status --porcelain=v2`, parsed into something browsable.
 *
 * The safety check in `git.ts` already reads porcelain **v1**, and correctly:
 * it only needs to know whether a worktree is dirty, and v1's flat lines answer
 * that in the fewest moving parts. This is the other job — showing a person
 * WHAT changed before they act on a worktree — and v1 is a poor source for it.
 *
 * v1 gives two status characters and a path. v2 gives the fields that make a
 * listing readable and unambiguous:
 *
 *   - staged and unstaged state as separate, explicit values, so "modified in
 *     both" is distinguishable from either alone;
 *   - renames and copies with their similarity score AND their original path,
 *     which v1 only hints at through an arrow inside the path field;
 *   - unmerged entries with their conflict stages, rather than one of v1's
 *     several overloaded two-letter codes;
 *   - a submodule field, so a dirty submodule is not silently a modified file.
 *
 * Parsing is deliberately total: an unrecognized line is skipped rather than
 * throwing. This feeds a viewer, and a future git version adding a record type
 * should cost that one row, not the whole screen.
 */

/** What happened to a path on one side (index or worktree). */
export type StatusChange = "unmodified" | "modified" | "added" | "deleted" | "renamed" | "copied" | "type-changed";

export interface StatusEntry {
  path: string;
  /** Staged state — what `git commit` would record. */
  staged: StatusChange;
  /** Unstaged state — what is different in the working tree. */
  unstaged: StatusChange;
  /** Present for renames and copies: where the content came from. */
  originalPath?: string;
  /** Rename/copy similarity, 0–100. */
  similarity?: number;
  /** True when the entry is a submodule rather than a file. */
  submodule?: boolean;
  /** Set on conflicts; the entry is neither staged nor unstaged but both. */
  unmerged?: boolean;
  untracked?: boolean;
  ignored?: boolean;
}

/** Single-letter XY codes shared by the ordinary and rename/copy records. */
const CHANGES: Readonly<Record<string, StatusChange>> = {
  ".": "unmodified",
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
  // Unmerged records reuse the same field for their conflict sides.
  U: "modified",
};

function toChange(code: string | undefined): StatusChange {
  return (code && CHANGES[code]) || "unmodified";
}

/**
 * A submodule field is `N...` when the entry is not one, and `S` followed by
 * three flags when it is. Only the distinction matters here.
 */
function isSubmodule(field: string | undefined): boolean {
  return field?.startsWith("S") === true;
}

/**
 * Parse porcelain v2 output.
 *
 * `-z` output is NUL-separated and puts a rename's original path in its own
 * record, so both separators are accepted: pass NUL-separated text and the
 * paired paths are read correctly, or newline-separated text and the tab form
 * is used instead. Callers that do not need exact paths under unusual filenames
 * can use either; a viewer should prefer `-z`.
 */
export function parsePorcelainV2(output: string, separator: "\0" | "\n" = "\n"): StatusEntry[] {
  const fields = output.split(separator);
  const entries: StatusEntry[] = [];

  for (let index = 0; index < fields.length; index++) {
    const line = fields[index];
    if (!line) continue;

    // `? <path>` — untracked. Neither side has a change to describe.
    if (line.startsWith("? ")) {
      entries.push({ path: line.slice(2), staged: "unmodified", unstaged: "unmodified", untracked: true });
      continue;
    }
    // `! <path>` — ignored. Only present when the caller asked for them.
    if (line.startsWith("! ")) {
      entries.push({ path: line.slice(2), staged: "unmodified", unstaged: "unmodified", ignored: true });
      continue;
    }

    // `1 XY sub mH mI mW hH hI <path>` — an ordinary change.
    if (line.startsWith("1 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      // The path is the rest of the line: it may itself contain spaces.
      const path = parts.slice(8).join(" ");
      if (!path) continue;
      entries.push({
        path,
        staged: toChange(xy[0]),
        unstaged: toChange(xy[1]),
        ...(isSubmodule(parts[2]) ? { submodule: true } : {}),
      });
      continue;
    }

    // `2 XY sub mH mI mW hH hI Xscore <path>` then the ORIGINAL path — a rename
    // or copy. Under `-z` the original is the next NUL-separated field; under
    // newlines it is tab-separated on the same line.
    if (line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const score = parts[8] ?? "";
      const rest = parts.slice(9).join(" ");
      if (!rest) continue;
      let path = rest;
      let originalPath: string | undefined;
      if (separator === "\0") {
        originalPath = fields[index + 1] || undefined;
        index += 1;
      } else {
        const tab = rest.indexOf("\t");
        if (tab >= 0) {
          path = rest.slice(0, tab);
          originalPath = rest.slice(tab + 1) || undefined;
        }
      }
      const similarity = Number.parseInt(score.slice(1), 10);
      entries.push({
        path,
        staged: toChange(xy[0]),
        unstaged: toChange(xy[1]),
        ...(originalPath ? { originalPath } : {}),
        ...(Number.isFinite(similarity) ? { similarity } : {}),
        ...(isSubmodule(parts[2]) ? { submodule: true } : {}),
      });
      continue;
    }

    // `u XY sub m1 m2 m3 mW h1 h2 h3 <path>` — unmerged. XY here is the pair of
    // conflict sides rather than staged/unstaged, which is why the entry is
    // flagged: rendering it as "staged X, unstaged Y" would be a lie.
    if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(10).join(" ");
      if (!path) continue;
      entries.push({
        path,
        staged: toChange(xy[0]),
        unstaged: toChange(xy[1]),
        unmerged: true,
        ...(isSubmodule(parts[2]) ? { submodule: true } : {}),
      });
    }
    // `# ` header lines and anything unrecognized are skipped: this feeds a
    // viewer, and a new record type should cost one row, not the screen.
  }

  return entries;
}

/** Compact one-line label, e.g. `MM src/a.ts` or `R95 new.ts ← old.ts`. */
export function formatStatusEntry(entry: StatusEntry): string {
  if (entry.untracked) return `?? ${entry.path}`;
  if (entry.ignored) return `!! ${entry.path}`;
  const code = `${letterFor(entry.staged)}${letterFor(entry.unstaged)}`;
  const marks = [
    entry.unmerged ? "conflict" : undefined,
    entry.submodule ? "submodule" : undefined,
    entry.similarity !== undefined ? `${entry.similarity}%` : undefined,
  ].filter(Boolean);
  const origin = entry.originalPath ? ` ← ${entry.originalPath}` : "";
  const suffix = marks.length > 0 ? ` (${marks.join(", ")})` : "";
  return `${code} ${entry.path}${origin}${suffix}`;
}

function letterFor(change: StatusChange): string {
  switch (change) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "type-changed":
      return "T";
    default:
      return ".";
  }
}

/**
 * Group entries the way a reader thinks about them, in the order a commit is
 * assembled: conflicts first because nothing else can proceed past them, then
 * what is staged, then what is not, then what is not tracked at all.
 */
export function groupStatusEntries(entries: readonly StatusEntry[]): {
  conflicted: StatusEntry[];
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: StatusEntry[];
  ignored: StatusEntry[];
} {
  const groups = {
    conflicted: [] as StatusEntry[],
    staged: [] as StatusEntry[],
    unstaged: [] as StatusEntry[],
    untracked: [] as StatusEntry[],
    ignored: [] as StatusEntry[],
  };
  for (const entry of entries) {
    if (entry.unmerged) groups.conflicted.push(entry);
    else if (entry.untracked) groups.untracked.push(entry);
    else if (entry.ignored) groups.ignored.push(entry);
    else {
      // A path can be in both: staged edits plus further unstaged ones. It is
      // listed under each, because "have I staged everything?" and "what is
      // still uncommitted?" are different questions with different answers.
      if (entry.staged !== "unmodified") groups.staged.push(entry);
      if (entry.unstaged !== "unmodified") groups.unstaged.push(entry);
    }
  }
  return groups;
}
