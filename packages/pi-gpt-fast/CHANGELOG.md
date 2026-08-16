# Changelog

## 1.2.1
### Patch Changes

- 24a8af4: Remove references to the maintainer's personal dotfile setup from shipped docs
  and source comments. Each constraint is restated as a property of the package
  itself: which manager owns a settings file, whether a project permits git
  worktrees, and installing a package from a single source. No runtime behavior
  changes.

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

## Unreleased

- Moved the dotfiles priority-tier extension into the independently publishable Signalridge package.
