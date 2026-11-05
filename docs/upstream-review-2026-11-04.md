# Upstream adoption and Pi 1.5 review — 2026-11-04

## Scope and method

This review starts from repository `0d824d1`. It compares pinned upstream source
changes with the locally maintained implementations, rather than treating a newer
version or release-note entry as a missing feature. External research and local
gap review were separate passes; a completeness pass identified additional port
sources and corrected several apparent gaps.

The synchronization scope is the maintained forks and adapted packages below.
The older Aliou, 99percentpeople and fl4p background implementations remain design
references, not synchronized forks. No second process owner is introduced. This
is not a fresh survey of the whole npm extension catalogue.

| Source | Prior checked ref | Reviewed ref | Scope |
| --- | --- | --- | --- |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) | `00de0cd9a198dfc7d1467e91ad8a6bc57641ae10` | `a356a124e10e3b7ed1b64ac7d66f69713532be7e` | Agent continuation, isolation, resource aliases and execution/UI ownership |
| [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) | `486f5c553cfc60ee0cecc99fdd16b23b75b0fd5a` | `980db40db9b1db3b8dc92b2b1837eb06841bfea2` | Analytics, Statusline, Stamp, PR, Worktree, LSP, BTW, compaction, Goal, Plan and Recall |
| [tmustier/pi-extensions](https://github.com/tmustier/pi-extensions) | `0c364147d53abe1ea4acc74795ebfea219d8b5a0` | `f2632e7da3cadc4f22fb8367e7c4454779ec1a05` | Ralph, Recap, Usage, Files, Code Actions, Tab Status and guidance adaptations |
| [ouzhenkun/pi-input-history](https://github.com/ouzhenkun/pi-input-history) | `8591664ebddacd0264b39c841e2ff688e7ef6591` | Same ref | No post-baseline production changes |
| [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) | `1f23be9b8986237afb78aa15e91bbb57d98ce784` | `ff0a986b88c223a0a746ed95cda8ddada236140c` | Rules/TTSR and secret-projection boundaries |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | `a37a28853822d470d15ae1764c97aed258087699` | `72c0d39c0572b4060e1a90cc9897300ef174c349` | Coordination and hardening reference, not a replacement runtime |
| [default-anton/pi-subdir-context](https://github.com/default-anton/pi-subdir-context) | `c63f4876ba39d85aa19cf4c308a337a971f97a1c` | Same ref | No post-baseline changes; local trust/branch restrictions remain |
| [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) | `46dbdfd78ab631bbf3ce41c2618bb173a5ec2725` | Same ref | Advisor source unchanged; do not import automatic extra consultations |
| [tomsej/pi-ext](https://github.com/tomsej/pi-ext) | `e132c44b3b06f88f7fcfb67b80c91698d8c1814f` | Same ref | No post-baseline Worktime reference changes |
| [earendil-works/pi](https://github.com/earendil-works/pi) | `v1.4.0` / `4a080252f06caf63a525d7873c5d94d3c23887e0` | `v1.5.0` / `f9a26365568127461c47a07a37dcb42c140a3ac5` | Exact host migration, not moving-main qualification |

## Selected adaptations

These decisions define the implementation and verification scope. They include
upstream feature ports and separately identified local correctness fixes; the
latter are not attributed as newly introduced upstream capabilities.

| Area | Decision | Required invariants |
| --- | --- | --- |
| Workflow overview | Workflows owns one rich below-editor overview; Subagents owns independent-agent presentation and exact agent operations. | Preserve phases, logical call progress, settled-token semantics, navigation, retained-child access, row budgets and projection publication. Do not import the upstream monolithic engine. |
| Persisted agent continuation | Adapt ordinary cold continuation under stable identity and current authorized policy. | Require exact SDK built-in public provider/API/model/endpoint proof; unknown custom URLs are not retained as route proof. No arbitrary session-path capability, managed-child ownership escape, raw parent history or silent recreation/downgrade of a missing isolated checkout. |
| Manual agent configuration | Persist effective manual choices through the existing Agent-tier catalogue. | Do not write retired model/thinking fields, introduce another catalogue, silently alter an existing tier, or reinterpret explicit `off` as inheritance. |
| Git/PR/Worktree output | Apply operation-specific combined output budgets and reject incomplete safety data. | Overflow differs from timeout; partial inventory cannot authorize cleanup, and uncertain mutations require inspection rather than automatic inverse operations. |
| Shared terminal UI | Qualify Kit 0.69 lifecycle/paging support across shared consumers. | Exactly-once disposal settlement, accepted-work draining, configured paging, safe wrapper forwarding and unchanged draft/consent ownership. |
| Native UI capabilities | Use injected renderer key hints and genuine inline-question blocked metadata. | Hints reflect current bindings without rewriting persisted facts; observers/loaders are not mislabeled as questions. |
| Cost/model observability | Preserve reported metadata and distinguish provider-reported, estimated and unknown values. | No repricing catalogue, inferred provider confirmation or changes to numeric totals; requested and reported model identities remain distinct. |
| Files browser | Preserve confirmed searches and use serialized, bounded asynchronous metadata work. | Stable ordering, cancellation/re-root fences, symlink boundaries, correct staged/rename inventory, and no conversion of public synchronous APIs into promises. |
| Ralph/Recap | Validate activation before ownership changes; finalize loops at settlement, use non-triggering banners and attribute recap requests to their session. | Preserve authenticated iteration identity, foreign/sibling ownership, manual turns, destination consent, cancellation and temporary recap presentation. Retain applicable upstream MIT notices. |
| Secrets | Harden cross-secret labels and special JSON keys; qualify an optional projection seam for cooperating auxiliary requests. | Keep request-only projections, existing reverse mappings, immutable stored entries, fail-closed handled errors and experimental opt-in. Do not claim arbitrary export/opaque-compaction protection. |
| Workflow result handling | Preflight complete managed requests before submission, apply supported schema keywords conjunctively and scan JSON linearly. | Keep the bounded schema vocabulary, completed resume prefix and ambiguous-admission cleanup fences. |

## Already present or deliberately not transplanted

- Explore already follows the existing tier policy; directory resource aliases,
  managed keyed execution, parent questions, budgets and ordinary handoff already
  have local implementations. Their appearance in upstream release notes is not
  evidence that they require another port.
- Local LSP navigation, preview-first rename and serialized edit ownership exceed
  the compared upstream implementation; wholesale replacement would regress them.
- Rules already have branch-correct receipts, explicit refresh boundaries and
  finalized-tool enforcement. Pi does not expose atomic stream discard-and-retry;
  OMP worker interruption, subscriptions and provider settings are not portable
  drop-in features.
- Remote-V2 compaction, opaque v2 checkpoints, layered fallback and explicit
  recovery remain local owners. Cross-profile replay, alternate compaction
  transports and new hosted services need separate privacy and acceptance work.
- Raw inherited parent history, private filesystem supervisors, remote placement,
  a second model registry, automatic reviewer/watchdog requests, AgentFS and
  private image-generation backends are not imported.
- Goal/Plan conversation-contract redesigns predate the compared delta; their
  broader persistence/continuation migration remains separate. Goal's passive
  completion timer releases the event loop without changing its lifetime. Recall
  adopts native viewport capture. Local Plan questions already use native
  `select`/`input`, which report blocking themselves, and there is no local
  settings-reload timer: no replacement questionnaire or watcher is introduced
  merely to reproduce upstream implementation details.
- Input History and the advisor/subdirectory-context sources did not advance.
  Local correctness/qualification changes must not be presented as new upstream
  releases. Optional new shortcut settings, minimum-span highlighting and Usage
  discovery concurrency are not prerequisites for this migration.
- Existing shipped `CHANGELOG.md` files already satisfy native update-notice
  discovery. No duplicate update-note controller, last-seen settings or root Pi
  manifest is added.

## API and accounting corrections

`AssistantMessage.responseModel` already existed in Pi 1.4; Pi 1.5 expands provider
population rather than introducing the declaration. Public deferred tool
execution APIs also predate this target. New-version presence alone is not a
portability proof.

Cold continuation qualifies catalog identity, not authentication-time endpoint
pinning or cross-profile/issuer replay. Public endpoint proof comes from the SDK's
built-in metadata, not a configured runtime catalogue or URL syntax. Signed,
redacted and unknown replay content remains unqualified.

Workflow `runningCalls` counts logical calls awaiting settlement, not physically
executing worker slots. Available workflow token totals come from completed call
results, not live in-flight usage. Presentation must not turn either value into
a stronger concurrency or billing claim.

## Qualification and release boundary

The development target is exact Pi 1.5.0. Its `pi-schema` change requires actual
host coercion/rejection and schema-inference checks, not merely dependency pins
or package-factory loading. Package and integration gates, native lifecycle
fixtures, packed-loader smoke, and regular/fullscreen CLI/PTY checks are separate
evidence surfaces; [compatibility](compatibility.md) records the qualified host
and remaining limits.

Capacity fixtures perform 8,300 serialized callbacks. Their finite outer process
and test-runner guards budget that transport work; production heartbeat,
cancellation, scope/ownership, cleanup deadlines and capacity assertions remain
independent. No skipped gate is a passing acceptance result.

The large-history native paging pressure case retains all 25 × 80 key/scroll
iterations and their native frames. Its finite 20-second outer test guard budgets
that measured rendering workload; source/row/cache bounds, all assertions and
production deadlines remain unchanged. Other viewer tests keep their existing
guards.

Long-history CPU qualification includes repeated ownership/durability checks and
unchanged transcript repaints. Bounded fingerprint reuse must revalidate raw
values and serialization semantics, including same-ID deep mutations; it cannot
replace native provenance or full-file durability checks. Stamp rendering must
still qualify the active native branch before reusing cost labels. Retained
workflow children must not keep the independent Fleet repaint timer alive.

Process-fixture success also requires actual child retirement, not just a green
test-runner exit. Clipboard test teardown must retain release/completion evidence
until its real SDK children exit, including cancelled actions and failed tests.
Synthetic CPU improvements are not measurements of a running user's idle CPU,
and source qualification does not prove that an older active installation has
received a fix.

Every changed published package needs its own Changeset. Packages version
independently, experiments remain opt-in, and publication follows the normal
reviewed Version Packages PR and Trusted Publishing process. Source changes do
not activate an already running installation.
