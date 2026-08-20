# Changelog

## 1.3.0
### Minor Changes

- bae8689: Complete the managed workflow parity and hardening pass. Workflows now forward and validate exact model/thinking, toolset, denylist, thread, and per-call worktree intent while pi-subagents remains the policy and lifecycle owner. Script resume accepts edited revisions, workflow removal is durable, stale lifecycle events are rejected, provider-limit errors pause runs, and the live progress/effort/trigger settings are persisted and bounded. Run identity is durable before dispatch, pause/dispose stop owned agents and reject waiters, and every background start/resume delivers its result. The protocol adds only optional fields and capability metadata, preserving older policy-free managed-spawn consumers; workflows fail closed with a diagnostic when the peer does not advertise managed policy support.

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

All notable changes to this package are documented here.

## [Unreleased]

### Added

- **Managed protocol library:** Added side-effect-free v3 channel, capability,
  owner, RPC envelope, spawn, terminal, and quiescence validators shared by the
  Signalridge subagent runtime and workflow orchestrator. v3 peers may omit the
  `workflowTiers` capability; tier-aware callers must require it before sending
  semantic tier fields.
