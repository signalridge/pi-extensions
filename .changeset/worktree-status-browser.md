---
"@signalridge/pi-worktree": minor
---

New `/worktree → Browse worktree status`: a readable view of what has actually changed in a worktree, grouped as conflicted / staged / unstaged / untracked.

It reads `git status --porcelain=v2`, not the v1 the existing safety check uses. That check is unchanged and stays on v1, correctly — it only needs to know whether a worktree is dirty, and v1's flat lines answer that in the fewest moving parts. This is the other job: a person reads the result before deciding whether to remove, switch away from, or commit in a worktree, and "3 changes" does not settle any of those. v2 is what makes the listing unambiguous — staged and unstaged as separate values rather than one overloaded pair of letters, a rename's similarity score *and* its original path, unmerged entries flagged as conflicts rather than rendered as a misleading staged/unstaged pair, and submodules distinguished from modified files.

Read with `-z`, so a path containing a newline or a quote is shown exactly as git wrote it. Parsing is total: an unrecognized record is skipped rather than throwing, so a future git version adding one costs that row and not the screen. `git.ts` keeps its raw-output boundary and stays free of intra-package imports — a test loads it standalone under Node's strip-only TypeScript, which cannot resolve a sibling `./x.js` to `x.ts` — so the parser lives beside it and is applied at the consumer.
