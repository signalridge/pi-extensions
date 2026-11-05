# Changelog

## 1.3.1
### Patch Changes

- 3096585: Move the development SDK pins to exact Pi 1.5.0 while retaining wildcard host-owned peers and canonical TypeBox 1.3.27. Import the advisor's schema builder directly from TypeBox and report the required `truncated` flag from local Git process adapters. Update SDK fixtures for the new baseline and pi-schema validation diagnostics without changing lifecycle, consent, or model-selection policy.

## 1.3.0
### Minor Changes

- da9ed0f: Initial experimental release: project and user rule files (`.pi/rules`, `.agents/rules`, Cursor `.cursor/rules/*.mdc`, `<agent dir>/rules`) delivered as an always-on prompt section, an on-demand index with a `read_rule` tool, path-glob offers, and `edit`/`write`/`bash` rules that remind or block at `tool_call`, with branch-persisted repeat policy. Project rules load only in trusted projects. Adapted from oh-my-pi's rule system without its mid-stream interruption.

### Patch Changes

- da9ed0f: Avoid nested native rename queues across asynchronous key resolution; preflight all targets, then recheck and write one queued target at a time with accurate partial-progress reporting. Reject model handoff mutations when a public session operation is already busy, preserve retry ownership, and conservatively migrate legacy handoffs without a native publication boundary. Match Pi's exact lowercase `file://` recognition while keeping other spellings literal.
- da9ed0f: - Reject rename hardlink aliases and retargeted queue identities before writes; support all LSP newline styles and identify possibly partially modified targets on write failure.
  - Fence pending physical Plan model mutations at cancellable navigation/replacement gates, reconcile handoffs by native selection chronology, and scope thinking-only restoration to its originating model.
  - Compose Goal guidance through an owned structured prompt section. Resolve overflow usage against physical response models and invalidate stale size evidence after persisted context edits in each independent continuation helper.
  - Persist queued Rules reminders/offers only at authenticated native admission, match file URL paths, and provide usable rule-file references when read_rule is unavailable.
  - Inherit nested workers' thinking from their immediate spawning session while preserving explicit policy precedence.
  - Refresh skill discovery for custom Analytics runs without consuming pending user attribution, and finalize successful Codex diagnostics only after UI cleanup and the final owned result fence.

## 1.2.0

- Initial experimental release: project and user rule files (`.pi/rules`, `.agents/rules`, `.cursor/rules/*.mdc`, `<agent dir>/rules`) delivered as one cache-stable system-prompt section, an on-demand index with a `read_rule` tool, glob-triggered rule offers, and regex rules enforced on `edit`/`write`/`bash`/`powershell` calls that either block the call or steer a hidden reminder. Repeat state (`once` per branch or `after-gap`) is recomputed from the session branch, so it survives `/reload` and re-arms after `/tree` navigation. Project rules load only in trusted projects. `/rules` lists rules, matches and rule-file errors.
