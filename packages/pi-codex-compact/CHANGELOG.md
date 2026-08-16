# Changelog

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

### Patch Changes

- Bound the resume lineage walk's skip window by the checkpoint's own creation time as well as the rendered summary's timestamp, so a session file whose entry timestamp is later than the checkpoint — hand-edited, migrated, or resumed across a clock skew — can no longer drop a native compaction summary the opaque replacement does not cover. The injected checkpoint marker also always carries a finite timestamp, and an impossible lineage is rejected before hashing the rest of the context.
- Keep re-expanding the opaque Codex checkpoint after a session resume by tolerating replayed older compaction summaries interleaved with the retained messages, instead of silently dropping the remote history.

## Unreleased

- Accept legacy `@narumitw/pi-codex-compact` checkpoint summaries while validating checkpoint payloads and kept-message lineage.
- Skip malformed/native compaction entries when selecting the newest valid Codex checkpoint instead of masking an older recoverable checkpoint.
- Replay legacy `@narumitw/pi-codex-compact` checkpoint markers after reload by accepting and normalizing canonical and legacy marker variants.
