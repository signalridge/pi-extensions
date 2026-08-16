# Changelog

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

## Unreleased

- Make Plan mode bash enforcement fail closed for shell composition, expansion, mutation, and unsafe Git or GitHub CLI arguments.
- Preserve an in-memory planning branch through fresh implementation replacement by snapshotting it as a private temporary parent session.
- Require `git --no-optional-locks status` and both `--no-ext-diff` and `--no-textconv` for Plan mode Git inspection.
- Reject bare `git branch` operands in Plan mode while allowing explicit read-only listing filters.
- Require `--no-ext-diff` and `--no-textconv` for patch-producing `git show` and `git log` inspection to prevent configured diff helpers from running.
