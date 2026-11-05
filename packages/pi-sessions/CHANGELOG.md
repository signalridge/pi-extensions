# Changelog

## 1.3.2
### Patch Changes

- 3096585: Move the development SDK pins to exact Pi 1.5.0 while retaining wildcard host-owned peers and canonical TypeBox 1.3.27. Import the advisor's schema builder directly from TypeBox and report the required `truncated` flag from local Git process adapters. Update SDK fixtures for the new baseline and pi-schema validation diagnostics without changing lifecycle, consent, or model-selection policy.

## 1.3.1
### Patch Changes

- da9ed0f: Fix two regressions on newer Pi hosts. On Pi 1.3 and later each `/sessions` or `/handoff` dialog left an invisible overlay open, so Pi behaved as if a dialog were always open and fullscreen scrollbar clicks and drags stopped working until restart; the placeholder overlay is now removed by its own handle. On Pi 1.2 and later the review editor and the session-picker filter showed literal cursor markers around the cursor instead of a highlighted cell; the sanitizer now admits Pi's own cursor markers while still cleaning untrusted input.

## 1.3.0
### Minor Changes

- 0ec64d1: Introduce an opt-in experimental package for human-controlled workspace/all-workspace session navigation and bounded, editable summary handoffs into linked sessions. Approval only prefills the editor; it never submits a model turn. Native custom entries support explicit recovery after reload.

### Patch Changes

- 74b65a5: Reject malformed assistant error text before restoration, snapshot stale in-memory handoff parents without rewriting history, revoke approval on subsequent delivered switch attempts, and cancel pending native character jumps before inserting reviewed paste.
- 0925139: Validate native system replay and discovery metadata before switching, migrate historical v2 messages without writes, revoke prefill after source retirement, and preserve review Undo, configured selection controls and foreign overlay focus. Make CLI fixture startup cleanup exception-safe and document the host's RPC observation limits.

## 1.2.0

- Initial experimental package: workspace-scoped session navigation and explicitly reviewed, linked summary handoffs. No automatic model turn or session-file deletion.
