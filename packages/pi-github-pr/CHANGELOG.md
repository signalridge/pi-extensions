# Changelog

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

### Patch Changes

- Narrow what a cancelled turn suppresses in the pull request status. A status that was already fetched successfully is now rendered even if the turn is aborted while the handler resumes, and a genuine `gh` failure — a missing binary, a broken login — is still reported when the abort races it, instead of leaving the previous status in place until the next poll. An already-cancelled turn still skips the `gh` call entirely.
- Keep the rendered pull request status and its expiry timer intact when a turn is aborted, so cancelling with Ctrl+C no longer replaces good PR status with a failure message.

## Unreleased

- Refresh package metadata and Pi namespace compatibility.
