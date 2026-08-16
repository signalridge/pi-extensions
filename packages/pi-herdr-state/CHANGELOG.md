# Changelog

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

## 0.1.1
### Patch Changes

- 4c50252: Bind Pi lifecycle reports to Herdr's protocol-v8 session identity before sending state, normalize supported session-start sources, use the Windows named-pipe endpoint where required, and dispose the old reporter during session replacement. The canonical package remains `@signalridge/pi-herdr-state`; remove the legacy package name before installing it.

## Unreleased

- Added the canonical `@signalridge/pi-herdr-state` package at `packages/pi-herdr-state`.
- Fixed protocol-v8 session binding, TTY-only activation, Windows named-pipe endpoints, and serialized session-before-state reporting for Herdr 0.8+.
- The previously published `@signalridge/herdr-pi-state` name remains a legacy package because npm cannot rename packages; uninstall it before installing the canonical replacement.
