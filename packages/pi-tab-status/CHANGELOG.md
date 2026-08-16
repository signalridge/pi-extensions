# Changelog

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

### Patch Changes

- Neutralize terminal control sequences and bidirectional overrides in the last three surfaces that rendered untrusted text raw: the recap the model writes from tool output, the workspace facts on the startup card, and the directory name written into the terminal title as an OSC escape sequence. The recap also sanitizes transcript text before it truncates it, so a cut can never hand the model half of an escape sequence.
- Publish the screenshots and example template the README points at, so the npm page no longer renders broken images or a dead file reference.
- Read `PI_TAB_STATUS_STYLE` when a title is formatted instead of freezing it at module load, so the style is a runtime input rather than an import-time side effect, and cover the full run lifecycle in both the legacy and ridgeline styles.

## Unreleased

- Add the optional text-only Signalridge Ridgeline tab-title style while preserving the legacy emoji format.

## [0.1.4] - 2026-05-07

### Changed
- Declare the `@earendil-works` Pi peer and development dependencies used by runtime imports.
- Update Pi extension imports to the new `@earendil-works` namespace.

## 0.1.3 - 2026-02-03
- Add preview image metadata for the extension listing.

## 0.1.2 - 2026-01-26
- Added note clarifying one active session per tab is tracked.

## 0.1.0 - 2026-01-13
- Initial release.
