# @signalridge/pi-goal

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

## 0.49.7

### Patch Changes

- fa9c938: Reduce idle startup imports by loading Goal presentation, Chat networking and UI, and Sync operation-specific modules only when their routes require them.

## 0.49.6

### Patch Changes

- 6f98395: Sanitize terminal-rendered Goal text, bound terminal-tool inputs and outputs, report malformed commands in headless modes, and keep runtime smoke coverage on public Pi APIs.
