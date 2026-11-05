# Changelog

## 1.4.3
### Patch Changes

- 3096585: Move the development SDK pins to exact Pi 1.5.0 while retaining wildcard host-owned peers and canonical TypeBox 1.3.27. Import the advisor's schema builder directly from TypeBox and report the required `truncated` flag from local Git process adapters. Update SDK fixtures for the new baseline and pi-schema validation diagnostics without changing lifecycle, consent, or model-selection policy.
- 3096585: Avoid repeatedly serializing unchanged native history with bounded, value-validated canonical fingerprint memoization. Validate array identity explicitly and exclude native raw JSON and boxed primitives even when their prototypes or descriptors look like plain data. Reuse exact canonical disk-line digests without weakening fresh ownership, ancestry, header, file-identity or durability verification.
- 3096585: Reject fractional or unsafe revision arguments before native integer coercion can turn them into a valid optimistic-concurrency revision. Preserve exact integer-string conversion, runtime graph/revision checks and persisted snapshot schemas.

## 1.4.2
### Patch Changes

- da9ed0f: Document Pi 1.4.0 as the tested host for the native checklist UI.

## 1.4.1
### Patch Changes

- 4d37546: Omit current-checklist context when the host excludes the model's todo tool, without reactivating tools or changing stored state. Clarify that the human /todo command is not model-callable and unavailable checklist operations do not block unrelated authorized work.

## 1.4.0
### Minor Changes

- a4dc1de: Omit routine verified-storage success text from file-backed tool results, model context and the Todo progress status. Keep all persistence verification and explicit volatile, not-yet-persisted and unavailable-storage notices unchanged.

## 1.3.0
### Minor Changes

- 0ec64d1: Introduce an experimental, independently published session/branch checklist with revision-checked, verified session-record mutations (with explicitly volatile in-memory mode), dependency validation, model context recovery, and an explicit terminal overlay.

### Patch Changes

- 74b65a5: Reject Todo writes beneath any uncommitted native ancestor, verify huge CRLF records with bounded streaming hashes, and initialize sanitized form values without remappable action keys.
- 0925139: Quarantine unresolved native session ancestry instead of resetting the checklist after failed writes. Accept legal JSONL whitespace for bounded conversation verification, preserve embedded description drafts and Undo with configured submit bindings, and support Kitty character commands without treating modified keys or pasted text as commands.

## 1.2.0

Initial experimental package baseline. Adds a revision-checked session/branch checklist, durable custom-entry recovery, dependency graph validation, bounded model context, and an explicit terminal overlay.
