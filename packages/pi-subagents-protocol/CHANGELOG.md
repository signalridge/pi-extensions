# Changelog

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
