# Changelog

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

## [0.1.5] - 2026-05-07

### Changed
- Declare the `@earendil-works` Pi peer and development dependencies used by runtime imports.
- Update Pi extension imports to the new `@earendil-works` namespace.

## 0.1.4 - 2026-02-03
- Add preview image metadata for the extension listing.

## 0.1.2 - 2026-01-26
- Add a src entry point so loading `code-actions/src` works with pi extension discovery.

## 0.1.1 - 2026-01-26
- Move extension source files into `code-actions/src` for clearer organization.

## 0.1.0 - 2026-01-13
- Initial release.
