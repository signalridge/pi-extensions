# Changelog

## 1.4.0
### Minor Changes

- c1b1741: Protocol v4: workflows use the Agent-tier catalogue directly.
  
  The wire contract changes, so the three packages move together: `pi-workflows`
  now declares `"@signalridge/pi-subagents": ">=1.9.0"`, and a peer outside that
  range fails the startup handshake with a diagnostic naming both packages rather
  than failing mid-run.
  
  The `small | medium | large` workflow-tier vocabulary and its mapping layer are
  gone. A managed request names an Agent tier — a key in the host's own
  `agentTiers` catalogue — and `resolveAgentTier()` is the single resolver for
  every spawn path. Removed with it: the wire's mapped `agentTier` field, the
  `workflow` settings key (retired with a warning naming it; `agentTiers.defaultTier`
  replaces `workflow.defaultTier`), and the per-call `model`/`thinking` selectors,
  which the validator now rejects rather than accepting and ignoring.
  
  Every v4 capability is required and every ping carries the host's tier catalogue,
  so an incomplete peer fails one check instead of five optional ones. Fresh
  installs ship `low`/`medium`/`high` profiles, all inheriting their model, and a
  managed call that names no tier falls back to `medium`, so a workflow runs on an
  unconfigured machine without this package choosing a vendor. Because `medium`
  inherits, that fallback lands on the parent session's model — it commits to an
  effort level, not to a vendor, so it does change the thinking level a managed
  call runs at when the parent session is set higher, and it does not move the
  work anywhere cheaper. What it buys is a named policy with a durable snapshot
  and a scope check; a workspace that wants cheaper managed work names a
  `defaultTier` whose profile pins a model. The fallback is scoped to calls that
  cannot inherit a parent model rather than being installed as
  `agentTiers.defaultTier`: a shipped catalogue default would have applied to
  every ordinary `Agent` spawn as well, silencing `defaultModel` and pinning a
  thinking level on machines that configured neither. The catalogue no longer
  ships a `fast` profile; it was the same (model, thinking) pair as `low`, and the
  one agent that named it (Explore) now names `low`. A user agent file that still
  says `agentTier: fast` is reported by the existing unknown-reference check when
  settings and agents load, rather than failing at its first spawn.
  
  `agentTiers.defaultTier` therefore has three states, and `/agents → Settings`
  offers all three rather than rendering two of them as one word: a named tier,
  `unset` (managed calls reach the shipped fallback), and `none` (recorded as
  `noDefaultTier`, which withdraws the fallback so managed calls fail closed).
  `setDefaultAgentTier` takes that choice as a tagged value, so a caller cannot
  express "no default" without saying which of the two it means.
  
  `resolveAgentTier` gained `requireTier` for that fallback, and the two things
  pre-resolution callers need are both answered by the resolver rather than
  restated beside it: `agentTierApplies()` for "will a tier own this spawn's
  model?", and `selectAgentTier()` for the tier key itself, which the managed
  path needs to label a tombstone and the lifecycle events before the runner has
  resolved anything.
  
  Because a tier now owns model resolution outright, the spawn paths stop
  pre-resolving one — and with it they stopped producing the model name the agent
  UI shows. The resolution callback carries that label back instead, so a tier
  that pins a model still names it in the viewer and the agent list, and a profile
  that inherits correctly shows none. The label rides beside the snapshot rather
  than inside it: the snapshot is a durable policy record a managed tombstone
  persists and revalidates, and a cosmetic string does not belong in it.
  
  Workflow resume now keys each cached call on the policy for that call's own tier
  rather than on a whole-catalogue fingerprint, so defining or editing an unrelated
  tier no longer forces a full re-execution — but only for a call that names its
  tier. A call that names none keeps the whole-catalogue key, because the host
  resolves those as `call > agent frontmatter > defaultTier` and frontmatter is
  not on this wire: an agent reaches a managed caller as a name. Keyed on
  `defaultTier`, such a call would be wrong twice over — replaying stale work
  after an edit to the tier its agent actually declares, and re-executing after an
  edit to a default it never reached. `agentTierPolicyIdentity()` therefore
  requires a tier rather than accepting `undefined` and folding the default in, so
  the wrong call cannot be written. Journal schema v4 and managed tombstone schema
  v2 are quarantined from older facts rather than migrated.
  
  The tier catalogue belongs to the user, names included. The built-in workflows
  and the ad-hoc script ship with this package, so a tier name they use that the
  host does not define is dropped in favour of the host's default rather than
  failing the run — they cannot assert which names exist on someone else's
  machine. A script the user wrote still fails closed on an undefined tier, since
  that is a typo in a catalogue they own. Shipped-ness travels with the script
  rather than with the frame that called it, so a user script that reaches a
  built-in through `workflow(name)` applies the built-in's rule to the built-in;
  the authoring skill now says outright that `low`/`medium`/`high` are the shipped
  profiles rather than names an authored script may assume.
  
  The managed routing policy published on the wire reports the default a managed
  call will actually get, fallback included, so a peer's replay identity cannot
  disagree with the host's selection; its sorts are code-unit rather than
  locale-dependent, so the same catalogue fingerprints identically everywhere. The
  workflow peer re-pings per start and resume instead of pinning the catalogue it
  saw at session start, and reports the host-selected tier back through an
  `onTierResolved` callback rather than by mutating the dispatch options.
  
  Fixes: a nested spawn no longer relabels an agent's frontmatter tier as
  caller-requested, which had turned a `scopeModels` warning into a refusal and
  misattributed the choice; the scheduler no longer freezes a frontmatter tier into
  a job, so editing the agent file takes effect at fire time; retired managed spawn
  keys are now bounded instead of growing for the life of a session; a
  scope refusal for a tier whose profile inherits its model now names the model
  that would have run instead of the literal `undefined`; and the retired
  `workflow` key warns once per process rather than on every settings read and
  every project write.
  
  The tier-key predicate and its length bound now have a single definition, in
  `pi-subagents-protocol`, which `pi-subagents` re-exports. The wire is the
  narrower of the two gates — a key one accepted and the other rejected could
  never reach a peer — so a second copy could only ever be a way for them to
  disagree. That one definition now also governs `blockedProfiles`, which was
  being validated by a helper that trims first: `" low"` became `"low"` there
  while the same value in `profiles` or `defaultTier` was refused outright. All
  three reject.
  
  `/agents → Settings` no longer names the fallback tier in the `unset` row's
  label. Which tier `unset` reaches depends on the catalogue, and a workspace that
  edits or deletes the shipped `medium` profile leaves it reaching nothing — at
  which point `unset` and `none` behave identically. The row's description asks
  the resolver what `unset` would currently resolve to and says that, including
  when the answer is "nothing".
  
  `pi-workflows` also gained the session-lifecycle handling this routing work
  needed to sit on. The engine has an explicit dispose lifecycle, so a protocol
  probe or a start that is in flight when a session ends rejects with a disposed
  error instead of resolving against an engine nobody owns. The tool, command and
  widget surfaces register exactly once and resolve the *current* engine on each
  use, rather than closing over the one that existed when they were registered —
  a session replacement previously left them pointing at a disposed engine. Tool
  and command handlers report failures as results rather than throwing out of the
  host's dispatch, and the lifecycle handler accepts `subagents:created` and
  `subagents:started` so a spawn's identity is recorded from the first event that
  carries it rather than only at completion.

## 1.3.1
### Patch Changes

- f714ea0: Publish the package versions already prepared by the previous release transition after its first publish attempt was blocked before npm publication.

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
