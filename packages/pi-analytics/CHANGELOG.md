# @signalridge/pi-analytics

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

## 0.49.6

### Patch Changes

- 3344477: Use Pi TUI Kit's published standalone confirmation for analytics deletion so Back remains side-effect free, TUI Ctrl+C closes the dashboard, and stale or failed confirmation cannot clear data.

## 0.49.5

### Patch Changes

- 4a9c94b: Preserve analytics write timeout errors when Node wraps aborted filesystem operations.
- Updated dependencies [2d79365]
  - @narumitw/pi-tui-kit@0.50.0

## 0.49.4

### Patch Changes

- d7b1c3f: Allow local analytics writes more time to complete during transient filesystem stalls.
