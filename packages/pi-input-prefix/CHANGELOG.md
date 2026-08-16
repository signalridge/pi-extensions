# Changelog

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

### Patch Changes

- Resolve the `PI_INPUT_PREFIX` prompt glyph by code point instead of UTF-16 code unit, so a single-cell non-BMP glyph is honoured rather than sliced into a lone surrogate and silently replaced by `>`, and move the resolution into `render.ts` with direct test coverage for the default, override, truncation, and double-width fallback cases.
- Resolve `PI_INPUT_PREFIX` by grapheme cluster instead of by code point, so a decomposed character keeps its combining mark rather than silently losing it. A cluster widened past one column by an emoji-presentation selector still falls back to its single-cell base glyph, and a genuinely wide glyph still falls back to `>`.

## Unreleased

- Moved the dotfiles prompt editor into the independently publishable Signalridge package.
- Document the Ridgeline `›` prompt default; the renderer remains theme-native and user-overridable.
