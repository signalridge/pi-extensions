# pi-codex-compact reference

[Start with the README](../README.md).

- [Bounded full-history folding](#bounded-full-history-folding)
- [Layered fallback over an opaque checkpoint](#layered-fallback-over-an-opaque-checkpoint)
- [Explicit recovery export (restricted)](#explicit-recovery-export-restricted)
- [Safe failure diagnostics](#safe-failure-diagnostics)
- [Source-free diagnostics](#source-free-diagnostics)
- [Relationship to Codex configuration](#relationship-to-codex-configuration)
- [Requirements and compatibility](#requirements-and-compatibility)
- [How it works](#how-it-works)
- [Privacy, storage, and limits](#privacy-storage-and-limits)
- [Experimental limitations](#experimental-limitations)

## Bounded full-history folding

Normal compaction may make sequential remote folds within one hook, with **at most eight
actual HTTP attempts total**, including transient retries and context-limit backoff. Extra requests
may add latency and cost. All stages retain the same canonical instructions, tools, model, and
credentials. Only closed conversation groups are split; the original opaque item and preceding raw
user backups are absorbed together in the first fold. Unsupported segmented histories fail closed.
Bounded folding accepts the native Codex JSON/zstd transport shape (`method`, `headers`, `body`,
`signal`); additional transport options and deferred coercions are rejected before sending.

Intermediate opaque results stay in memory. A checkpoint is returned only after **every original
input occurrence** has been absorbed; raw user backups and the host's retained-tail semantics remain
unchanged. Failed folds never publish a prefix checkpoint. Existing opaque history is preserved on
failure, either unchanged (cancellation) or beneath a layered summary (below); the non-opaque
native-fallback policy above is unchanged.

The initial target is the smaller of 4 MiB and three bytes per available context token, with an
8 MiB serialized-request hard cap. This is a heuristic, not an exact token count or a guarantee of
fit. Structured context-window errors can shrink only to earlier closed boundaries, within the same
eight-attempt budget and overall authentication/request deadline. The host may start another
operation; this extension does **not** fix core continuation after failed compaction.

## Layered fallback over an opaque checkpoint

Once the effective boundary is an opaque checkpoint, Pi's native summary cannot replace it without
losing the older history only that item holds. Cancelling every failed attempt preserves it, but a
backend that keeps failing leaves the context growing past the model's window. The layered fallback
keeps the opaque item **exactly** and summarizes only what this compaction drops after it.

It runs only when all of these hold: canonical history is authorized, credentials were resolved,
the effective checkpoint is valid, compatible with the active model and its kept lineage projects,
and the authorized remote attempt failed with `remote_http_error`, `remote_timeout`,
`remote_transport_error`, `remote_provider_error`, `remote_context_window_exceeded`,
`segmentation_unsupported`, `remote_attempt_budget_exhausted`, `remote_response_invalid` or
`local_compaction_failed`. Malformed or incompatible checkpoints, missing or denied consent,
credential failures, the local `loadout_mismatch`/`payload_rejected` guards (unsent drift never
reaches transport), `state_divergence`, model/branch changes and caller cancellation keep cancelling.

The fallback makes **one** native summary request with Pi's public `generateSummaryWithUsage`, through
the same provider, model, resolved credentials, abort signal, thinking level and `/compact` focus
instructions as the failed request. It uses SSE, no cache retention, `maxRetries` transport retries and
no extra Pi-level retry, within the smaller of `stageTimeoutMs` and the time left of `requestTimeoutMs`.
Its input is Pi's `messagesToSummarize` plus any split-turn prefix, minus the remote checkpoint's own
kept messages that its opaque item already contains. The placeholder summary and replay marker are
never summarized. An aborted, truncated, empty, failed or late summary cancels exactly as before.

On success the hook returns a **version 2** checkpoint: the previous replacement history unchanged,
followed by one delimited user message carrying the summary, with a new checkpoint ID, marker, kept
fingerprints and every other field computed as for a remote result. The summary is bounded to
`replacementTokenBudget` × 4 characters (its end is truncated with a marker) and the whole history to
8 MiB. Because the summary covers only dropped history, version 2 replays Pi's kept messages verbatim
after it, whereas a remote opaque item already contains them. Another failure over a layered
checkpoint uses Pi's update prompt to merge its summary and kept messages into **one** new summary;
summaries never stack. The next successful remote compaction sends the layered history as input, and
its new opaque item absorbs the summary, which is not kept as a user backup. Reload, resume and fork
replay version 2 as they do version 1, and recovery export sends it as its prefix request's prior
history. Releases 1.10 and earlier treat version 2 as malformed: they cancel compaction and do not
replay it.

The summary is readable plaintext produced from canonical history under the same authorization as
Remote V2 (the consent notice already covers Pi's native summary); like any native summary it is lossy
for the dropped span and bypasses request-local filters. Set `layeredFallback` to `false` to restore
cancel-only behavior.

## Explicit recovery export (restricted)

If full remote compaction cannot fit, **Recovery export (new session)** under `/codex-compact` offers
an explicit one-shot alternative. It is never an automatic fallback, and selecting **Compact now**
retains its existing full-compaction behavior. This recovery action requires an idle, persisted TUI
session with no pending work, a compatible validated prior opaque checkpoint, and unchanged canonical
prompt/tools/model and source lineage. RPC/headless recovery is not supported.

Pi's public settings getters resolve the active model's `compaction.keepRecentTokens` (including
model overrides and the host's trusted effective settings). Its public cut helper selects a suffix
from an in-memory canonical entry view; this is not private native compaction preparation. The split
must leave one prior marker plus proven provider-visible new prefix content and a nonempty smaller,
completely unsent suffix with proven provider-visible content. Excluded bash records and errored or
aborted assistant partials do not prove either condition; token estimates alone are insufficient. Only `user`, `assistant`, `toolResult`, `custom`, and `bashExecution` messages are
supported; summaries, ambiguous IDs, missing results, and crossed tool pairs reject the operation.
Both raw and provider-filtered halves must have closed tool pairs: failed/aborted calls cannot leave
orphan results. Validation also rejects empty/colliding effective Codex call IDs after Responses
sanitization/truncation, including across the split; stored IDs are never rewritten.
No cut is guessed or recursively retried. Existing consent, loadout, frozen-wire, model and ownership
gates remain in force; recovery does not establish or fabricate loadout evidence.

Selecting recovery only shows an **informed, read-only offer** with prefix/suffix counts and an exact
`/codex-compact confirm-recovery <UUID>` command. It does not authenticate, send, stage files, or change
settings. To authorize one export, deliberately run that exact command within five minutes in the same
unchanged TUI session. The nonce is consumed before asynchronous work and cannot be reused. Decline by
not confirming, or use `/codex-compact cancel-recovery`. Ordinary input/new runs, model/session/tree
changes, reload/shutdown, expiry, or source/loadout/settings drift invalidate the offer. Malformed,
unknown, expired, and duplicate confirmations never fall through to compaction or an ordinary send.
Recovery never opens a native confirmation/custom dialog; silent offer expiry/cancellation cannot
close another extension's newer selector or dialog.

This explicit confirmation grants canonical-history permission **once**, even when **Allow canonical
history** is disabled; it never toggles that setting. The full-compaction consent path is unchanged.
The confirmed prefix uses the same canonical system/tool envelope and privacy boundary described
below: request-local filters are bypassed, while persisted context edits remain honored. It makes
one forced-SSE prefix request with **zero transport retries**, no ordinary preparation probe, no
full-first request, and no native fallback. Progress is a uniquely keyed **nonmodal** widget, not a
custom dialog/editor. Escape, Ctrl+C, new terminal input, or widget disposal cancels only this recovery;
input remains available to other UI. Kitty key-release events (including the Enter release after
confirmation) are ignored; actual new keypresses still cancel synchronously. Scoped terminal-input
subscriptions and disposable widgets are
required capabilities. Cleanup never calls a custom dialog's completion callback or clears another
widget's key. Provider identity, stream/auth implementations, structural model/profile state and the
actual TUI owner are pinned before confirmation. Source/loadout drift or UI/mode rebinding rejects
continuation before credentials, transport or publication, even before lifecycle cleanup runs.
Public APIs do not expose an immediate notification of every arbitrary rebind: unsignalled rebinding
is detected at the next continuation boundary, while native widget disposal and lifecycle/input
cancellation abort synchronously. Late responses cannot publish or notify stale UI. A cold loadout
mismatch reports a fixed safe diagnostic without authenticating; an owned deadline reports timeout
only to a still-current owner, never after an earlier user/session cancellation.
An offline native-reopen control reaches a read-only offer with an unchanged synthetic loadout and
no post-reopen warm-up or injected observation; changing its active tools still fails closed. This
does not qualify arbitrary resumed loadouts or establish real-target cold-load eligibility.

On acceptance, the extension privately stages and validates a fresh current-format native session:
one resolved system envelope, one ordinary V1 **retain-none** checkpoint, then the exact model-visible
unsent suffix appended as new entries, and one **fresh recovery-model selection** after all historical
assistant attribution. Native resume without a model override therefore selects the issuing compatible
model, not a configured default or a historical suffix model. No old raw summaries, compactions, abandoned branches,
control state, or pending queues are copied. Reasoning signatures, media, tool IDs/results, order,
and model attribution are preserved. Copied historical assistant/tool-result **usage and cost are
reset to zero**: original accounting remains in the untouched source, old large usage cannot become
a new context baseline, and global billing is not counted twice. The new checkpoint records only
the actual recovery request's usage. This is not byte-identical raw-history copying.

The complete file is fsynced and replay-validated from an open, pinned file descriptor using public
read-only parsing/in-memory reconstruction, never a path-based native open that could repair a
replacement file. Private staging creation and its initial identity pin are synchronous before any
asynchronous boundary. Descriptor size/mtime/ctime are pinned **before** reading and verified immediately
afterward and before publication against that same baseline, rejecting read-completion mutations. Destination/staging directories and the file's device/inode/type are checked again
**after** the final owner callback, immediately before synchronous no-replace publication. Exports
over 64 MiB are rejected. Cleanup unlinks only a verified owned file and removes its directory only
if empty; uncertain ownership or foreign contents may leave staging artifacts. It never recursively
removes a replacement directory, the original, backups, or a completed published export. These checks
detect observed path/symlink swaps, not every adversarial same-UID race inside portable path-based
link/unlink syscalls; the destination directory must not be concurrently controlled by an adversary. A directory-durability warning can leave
a complete usable export available. Committed publication synchronously clears the request deadline,
reports success only to the still-current owner, and retires its own progress before asynchronous
descriptor cleanup; a held close cannot hide the new ID/path or become a late timeout. The result
reports its new ID/path; open it explicitly with
`/resume`. **No session switch or ordinary follow-up is sent automatically.**

The original session is **not repaired in place**, and its backup is unchanged. A smaller prefix
can still exceed the backend window or fail for other reasons; old usage and byte counts do not
prove fit. Even an accepted export does not prove the next ordinary request will fit. This restricted
experimental capability makes no backend recovery, cross-model compatibility, or migration promise.
Keep the source and backups; offline fixtures do not establish live server acceptance.

## Safe failure diagnostics

A failed authorized attempt reports a fixed reason code, not a guessed backend cause. With an
active opaque checkpoint, a layered result names the remote reason it replaced, and any cancellation
retains **cancelled to preserve the existing opaque checkpoint** semantics, stating whether the layered
summary failed, timed out or is off, for example:

```text
Codex remote compaction failed; kept the opaque checkpoint and added Pi's readable summary of newer history (layered fallback). [remote_http_error; HTTP 503]
Compaction cancelled to preserve the existing opaque checkpoint. [remote_http_error; HTTP 503] The layered summary fallback also failed.
Compaction cancelled to preserve the existing opaque checkpoint. [remote_http_error; HTTP 429] Layered fallback is off.
Compaction cancelled to preserve the existing opaque checkpoint. [authentication_failed]
```

Without an effective opaque boundary, an authorized failure can still use Pi-native compaction;
its optional fallback warning carries the same diagnostic. `notifyOnFallback` controls that warning and
the layered-result notice, but never suppresses opaque-checkpoint cancellation warnings. Notifications
and progress status are best effort: a UI failure cannot turn opaque cancellation into native fallback
or undo a layered result.

| Fixed reason code | Known observation (not a provider diagnosis) |
| --- | --- |
| `authentication_failed` / `authentication_timeout` | Credential resolution threw / the extension's authentication wait deadline expired. |
| `credentials_unavailable` / `provider_unavailable` | No usable credential / no available provider implementation. |
| `checkpoint_malformed` / `checkpoint_incompatible` | The early opaque-boundary gate rejected checkpoint details / active provider, API, or exact model ID. |
| `checkpoint_projection_failed` | Canonical checkpoint projection failed its anchor or lineage checks, or could not be built. |
| `loadout_mismatch` | Canonical/effective prompt views, their required ordinary-request witness, tools, or the frozen wire snapshot could not be reproduced; this includes a locally rejected validator even if the provider swallows its exception. |
| `payload_rejected` | Local provider-context or Remote V2 payload preparation was rejected. |
| `remote_http_error; HTTP NNN` | The intercepted transport returned a non-success HTTP response. Only an integer `Response.status` from 100–599 is included, when valid. |
| `remote_timeout` | The extension-owned remote deadline expired, including response-body inspection. |
| `remote_transport_error` | Fetch or response-body reading failed without a more specific safe observation. |
| `remote_provider_error` | The provider threw/emitted an error, or SSE reported terminal failure, cancellation, or incomplete output, without a more specific safe observation. Arbitrary text is ignored. |
| `remote_context_window_exceeded` | JSON SSE reported exactly `context_window_exceeded` or `context_length_exceeded` at `code` / `error.code` on an `error` event, or `response.error.code` on `response.failed`. This is one fixed observation code, not overflow recovery or a diagnosis of an earlier failure. |
| `remote_response_invalid` | A successful HTTP response had absent, malformed, unsupported, oversized, or otherwise invalid compaction SSE. |
| `state_divergence` | Live prompt/tools no longer matched the completed request; the result was discarded. |
| `local_compaction_failed` | Local checkpoint construction failed after the response was accepted. |

Local cancellation is not an HTTP/provider failure. When UI is available and the operation still
belongs to the same non-aborted session owner, cancellation warnings distinguish:

| Fixed cancellation code | Known observation |
| --- | --- |
| `canonical_consent_required` | Persistent canonical-history consent is absent and no suitable one-operation TUI confirmation is available. |
| `canonical_consent_denied` | One-operation confirmation did not grant consent, including denial, uncertain/throwing result, or dialog timeout. |
| `preparation_model_changed` | The same owner's active provider/API/model route changed after preparation. No route values are shown. |
| `preparation_branch_changed` | The same owner's source lineage or leaf changed beyond the narrow Goal bookkeeping allowance below. No IDs or history are shown. |

These warnings never grant consent, request credentials for an unconsented operation, or enable
native fallback. With an effective opaque boundary they retain the checkpoint-preservation wording.
Explicit caller abort and retired session/reload/tree/shutdown owners remain silent; a late consent
or credential continuation cannot notify stale UI. Headless modes without UI still return only
cancellation, with no arbitrary error payload; the private source-free operation log described below also applies in headless mode. A later successful transport retry
does not inherit an earlier attempt's HTTP status; an owned deadline may supersede an HTTP response
whose body stalls. Fatal SSE inspection (invalid items, byte limits, or terminal provider error types)
cancels the provider and source promptly rather than waiting for EOF or relabelling the known failure
as timeout. A terminal provider failure also cancels promptly without awaiting an unfinished body
inspection or iterator closure, preserving any already observed safe failure. Local decoding/validation
failures are not classified as network read errors. A throwing
ownership callback/getter fails closed as source-free cancellation. Malformed/deep unsupported
checkpoint details return validation failure rather than escaping the hook into native fallback.
Successful compaction accepts `response.completed` and the built-in provider's `response.done`
alias, with absent (legacy) or `completed` status. Known unsuccessful terminal statuses and explicit
`response.incomplete` / `response.cancelled` events fail promptly, even without EOF. Other present
terminal statuses are invalid. Output-item and terminal-output copies are deduplicated, still requiring
exactly one bounded opaque item. CRLF delimiters are normalized to LF only on the successful SSE branch
consumed by the built-in provider, including fragmented CR/LF bytes; the inspector retains original
bytes and its 8 MiB limit. The normalized branch omits the original `content-length`. Non-success HTTP
bodies and existing retries are unchanged.

The protocol fixes above add no extra model round, relaxed loadout equality, automatic checkpoint
migration, or new retry. Existing bounded provider retries are unchanged. These offline-proven
protocol fixes do not establish the cause of an unknown live failure.

Pi snapshots the compaction branch before running extension hooks sequentially. An earlier Goal
hook can then append plain `custom` records with exactly `customType: "goal-state"`. Preparation
allows only that bookkeeping tail: the complete original ID lineage must remain an exact prefix,
all appended IDs must be fresh, unique, nonempty strings with parents linking exactly from the
original tip, and the reported live leaf must equal the final branch ID. No Goal data is read.
This is not generic custom-record safety: unknown custom types (including `pi.virtual-model-state`),
custom messages, context edits, model/system changes, and other entries still invalidate preparation.
Session ownership, cancellation, consent, model routing, fresh tool evidence, exact wire validation,
and both prepared/latest canonical prompt and tool checks remain enforced, including after the
response. Offline regressions cover this ordering case, not proven recovery of a live session.

These diagnostics contain no error messages or causes, status text, bodies, headers, URLs,
credentials, checkpoint contents, history, or arbitrary provider-event text. These reason-code notices add no arbitrary debug text, setting or upload; the separate bounded private operation log uses the source-free fields documented below. They help scope a **next manually authorized retry**:
check authentication for credential failures, or establish a fresh unchanged ordinary request's
loadout evidence for a loadout mismatch. Only checkpoint incompatibility suggests the original
model; HTTP/authentication/loadout failures do not imply a model mismatch. The codes do not identify
an unknown live backend failure or claim to repair it. Confirming that failure requires a separately
authorized retry and observation of its safe code/status; installation and live requests are not
performed by repository tests.

## Source-free diagnostics

Run **`/codex-compact diagnostics`** in the TUI to view this session's most recent operation. The
read-only command neither sends a model message nor appends a session entry. It reports the last stage,
closed outcome/error and timeout scope, fold/HTTP counts, elapsed time, and the captured stage/total
limits. `prepared` means a complete result was returned to Pi, **not** that the host persisted it.
`layered` means Remote V2 failed with the reported code and a layered checkpoint was returned instead;
a `failure` whose last stage is `layered_summary` means that fallback ran and also failed. The error
code and timeout scope always describe the remote failure. Fold and HTTP-attempt counts cover Remote
V2 only, while token/cost totals include the layered summary's native usage.
The normal deadline is checked before returning that result; host commit latency is outside the
extension's ownership. Recovery also checks the clock at its last pre-publication boundary. A
publication already begun within budget is not undone or hidden by later durability/cleanup latency.
Manual, threshold, overflow and recovery triggers are distinguished; older hosts without a reason use
`unknown`. A stage report identifies observed progress, not the underlying cause of a live timeout.

Best-effort private diagnostics are also appended in headless mode to
`<getAgentDir()>/pi-codex-compact-diagnostics.jsonl`. Rows contain only an operation UUID, a one-way
session correlation, fixed stages/codes, timestamps, bounded counts, separate request/response byte
counts, and finite nonnegative native token/cache/cost scalars. No prompt, tool, input/output body,
opaque checkpoint, URL, credential, header, environment, provider error text, session path or raw
session ID is recorded. The provider remains authoritative for usage/cost; no wire usage is invented.

Persistence has at most 128 rows per operation, a bounded queue and a 1 MiB file cap. New files use
`0600`; readers/writers require a regular, private, single-link file with the extension's schema marker.
Symlinks, foreign/malformed files and full logs are not rewritten or deleted; releases 1.10 and earlier
treat rows with the `layered_summary` stage or `layered` outcome as foreign and stop appending. A non-waiting owned
`.lock` serializes writers across processes/reloads; an existing or stale lock skips logging rather
than recovering/deleting it. Logging failures never delay the network or checkpoint commit. The
command uses recent in-memory rows when available and bounds persisted reads to 500 ms. Logging is
not an audit guarantee: busy/full/unavailable storage may drop rows, and no automatic rotation occurs.

Native Codex already recognizes completed/done SSE terminals without HTTP EOF. The extension stops
its event iterator at the provider's ordinary `done`, preserves exact native usage/cost, and does not
await potentially hanging iterator cleanup. Its independent strict wire inspector must still validate
one unique bounded opaque item and a successful terminal before any result can be returned.

## Relationship to Codex configuration

This extension does **not** read `~/.codex/config.toml`.

| Codex setting | Extension behavior |
| --- | --- |
| `features.remote_compaction_v2` | Conceptually corresponds to this extension's `enabled`; it is not imported. |
| `model_auto_compact_token_limit` | Not duplicated. Pi's own compaction threshold remains authoritative. |
| `model_auto_compact_token_limit_scope` | Not supported; Pi extensions do not own Codex's compact-window lineage. |
| `compact_prompt` / `experimental_compact_prompt_file` | Not used by Remote V2, whose opaque checkpoint is generated by the server. |
| `features.token_budget` | Not supported; token-budget context reset is a different experimental strategy. |

## Requirements and compatibility

- Pi APIs compatible with the package's declared peer dependencies.
- The built-in provider `openai-codex`.
- API `openai-codex-responses` on the active model.
- A working OpenAI Codex OAuth login and Remote V2 entitlement.

Historical automated SDK regressions used **Pi 1.4.0**; current development pins target **Pi 1.5.0**, not a new whole-host acceptance claim. Offline prompt-witness and automatic Goal/Compact composition regressions use matched Pi peers and synthetic credentials/SSE transports.
These checks do not establish whole-host compatibility, live backend acceptance, or recovery of an
already oversized conversation. Live backend diagnosis requires a separately authorized retry.

OpenAI API-key, Azure, GitHub Copilot, and arbitrary Responses-compatible providers are not
supported. The built-in Codex provider's credential-resolved destination is honored together with
its API key, headers, and environment; a configured destination must implement the same Codex wire
contract. Compatibility with arbitrary proxies is not guaranteed. Switching to another provider or
model leaves Pi's visible fallback marker plus retained recent messages in ordinary request context;
those requests are not blocked. While enabled, this hook cancels compaction on that incompatible
active opaque boundary rather than replacing it with a native summary of the marker. Switching back
to the checkpoint's original compatible model restores opaque replay. No cross-model replay,
provider transfer, or automatic checkpoint migration is performed.

## How it works

1. Pi prepares compaction and selects the recent message suffix it will retain.
2. While enabled, the extension first cancels if the effective boundary is opaque and its checkpoint
   is malformed or incompatible with the active provider/API/model ID. Superseded opaque history
   does not activate this gate. It then captures session/branch ownership and requires canonical-history authorization,
   before resolving credentials. TUI confirmation is cancellable, expires after five minutes, and
   grants only this operation; persistent authorization is a separate explicit settings toggle.
   It then projects an earlier compatible checkpoint, if present, into the canonical Responses input.
3. It appends exactly one final `compaction_trigger` and sends a normal authenticated Codex Responses
   SSE request with cache retention disabled.
4. It requires a completed response containing exactly one non-empty opaque `compaction` item.
5. It constructs bounded replacement history from recent raw user-role Responses items followed by
   the opaque item. If an eligible remote failure occurs over a compatible checkpoint instead, the
   layered fallback reuses that checkpoint's history followed by one readable summary (version 2).
6. It stores that history and fingerprints of Pi's retained suffix in versioned
   `CompactionEntry.details`.
7. On later compatible requests, it replaces an exactly validated marker with the persisted
   replacement history immediately before provider dispatch. A layered checkpoint keeps Pi's retained
   suffix after it verbatim; a remote one already contains it.

If fingerprints, model identity, payload shape, or marker count do not match exactly, the extension
leaves Pi's visible fallback context unchanged instead of guessing.

Loadout hooks can transform model-facing tool descriptions without changing the raw registry.
The extension recognizes those transformations only after fresh agent-context preparation and a
provider payload whose effective tool names and descriptions match the persisted declarations.
Supported wire declarations are the original top-level `tools` plus ordered, nonempty
`input` groups shaped as `{ type: "additional_tools", role: "developer", tools: [...] }`, including
Pi's native additive tool declarations. Names must be unique across all declarations; redefinitions,
missing/hidden tools, other group roles or fields, and tool-search updates (`tool_search_call` /
`tool_search_output`) are rejected. The raw recorded/registry membership and schema checks still apply.
It freezes both public tool surfaces and the original top-level tools plus ordered additive groups,
including schema, format, and strictness metadata; Remote V2 must reproduce that exact declaration
surface before sending. After successfully projecting a prior checkpoint, hosts exposing
`getCurrentSystemMessage` supply one resolved **canonical** system head for the remote request,
matching Pi's restoration after the ordinary checkpoint context hook. This avoids replaying historical
additive system entries in a different wire layout. First compaction and legacy hosts retain their
existing path; preflight and post-response guards still check the unmodified canonical transcript.
No request-local filter output is reused. Flattening, regrouping, or reordering declarations is not equivalent proof,
even with the same effective tool set. Ordinary input text, messages, and checkpoint content are not
retained or compared by this tracker. System-prompt views are separate ephemeral evidence, described
below. Cached provider callbacks cannot approve unsent registry edits,
and hidden declarations cause Pi-native fallback (or cancellation with an active opaque boundary)
rather than restoring hidden tools remotely. Evidence is
in-memory only and resets on startup, reload, or tree navigation. A fresh, unchanged normal request
can establish it again; prompt, tool, and schema changes remain guarded. For a loadout mismatch, a
user-authorized short ordinary request on the checkpoint's issuing compatible model, then manual
compaction without an intervening reload, can establish and reuse that evidence. This does not
bypass consent or equality checks and is not a fix for an unknown backend failure.

### Witnessed request-local system prompts

On structured-transcript hosts, a run-local forced prompt (for example active Goal guidance) may
legitimately differ from the persisted canonical prompt. Remote V2 admits this pair only after fresh
native `context` preparation captures **both** strings and the public ordinary
`before_provider_request` callback reproduces the same pair and accepted tool declarations. The
payload must have its own ordinary data `instructions` string **exactly** equal to the effective
prompt; accessors, proxies, serialization overrides, missing/non-string instructions and unsupported
wire shapes cannot prove it. No prefix recognition, whitespace normalization, serializer preview,
extra model request, or remote-compaction callback establishes this evidence. Empty canonical text
with a divergent forced prompt is unsupported: provider fallback instructions are not guessed.

Full compaction still sends the resolved **canonical** system envelope, not ephemeral forced text.
Its frozen validator checks canonical `instructions` for an operation admitted by this witness,
beside the unchanged exact top-level tools and ordered additive groups. Ordinary requests keep their
effective guidance. Both current prompt strings must still match the same owner/session witness;
canonical-only or effective-only drift, missing preparation/observation, reload or tree navigation
rejects the divergent operation. Equal canonical/effective prompts retain the existing cold/unforced
path and do not inherit an obsolete forced prompt's instruction constraint. Prompt views live only
in weakly keyed memory, never checkpoint details, settings or diagnostics.

This is **callback-level evidence**, not a guaranteed final packet after arbitrary later trusted
payload hooks. It is not a hard network fence or a way to halt Pi's ordinary continuation after
cancelled compaction. Such continuation, host usage estimation and backend context-window limits
remain outside this fix; in particular it does not repair an already stranded/oversized conversation
or turn `remote_context_window_exceeded` into successful recovery. Explicit nonce-authorized recovery
export remains a separate unchanged action, not an automatic fallback.

## Privacy, storage, and limits

Remote compaction sends Pi's **persisted canonical projection**, system instructions, and tool
schemas to the selected model's credential-resolved Codex destination. It honors durable
`context_edit` omissions/replacements; it does not send unprojected raw session entries.

This is **not** a snapshot of the final context sent in an ordinary model request. Pi exposes
no such snapshot to extensions. Remote V2 does not invoke ordinary `context`,
`context_with_system`, or `before_provider_request` handlers. Pi's native summary also bypasses
ordinary context filters. Request-local privacy filters, hidden custom content, and historical
persisted workflow arming can therefore differ from ordinary model context. No generic text stripping can establish equivalent privacy. New request-local guidance
that is not persisted does not become canonical history, but existing persisted content remains.

Default `allowCanonicalHistory: false` requires a clear, one-operation TUI confirmation. No UI,
RPC, denial, cancellation, uncertain dialog result, or retired ownership returns cancellation:
**no credentials, remote request, checkpoint, or native summary fallback**. Native fallback alone
is not privacy-safe: Pi's native summary also consumes canonical history without these filters.
Malformed or provider/API/model-incompatible active opaque checkpoints cancel even before this
consent step, including on unsupported providers. After explicit authorization, remote failure may
use that native summary of the whole history only if the effective compaction boundary is not opaque.
Over an active opaque checkpoint it would contain only its portability warning and recent messages,
losing effective access to its older history; the layered fallback instead summarizes only the newly
dropped history beside the kept opaque item, and otherwise compaction cancels. For checkpoint incompatibility, retry with
the checkpoint's original model; for other failures, use the safe reason code above to scope a
manually authorized retry. Alternatively, recover a pre-compaction branch and verify a readable
summary before migrating. An older opaque
record already superseded by a native boundary does not prevent fallback. Consent is never reused
for a changed session/branch. Disabling this extension's hook explicitly leaves native compaction
outside these gates. This is compaction safety, not universal request blocking or a privacy policy
for unsupported models or other extensions: ordinary mismatched requests still see only the fallback
marker and retained recent messages.

The session stores the opaque compaction item, bounded recent user-role Responses items and, for a
layered checkpoint, one readable summary, including canonical content you authorized even if ordinary
filters hid it. Replay can restore that
content after filters have run, including after reload. The authorization setting gates **new
compactions**, not replay of an existing checkpoint (including one created by an earlier version).
Opaque items cannot be inspected or selectively redacted. Authorization is not persisted in
checkpoint details. OAuth tokens, headers, environment secrets, and destination URLs are not
stored there. This extension's compaction-failure notifications use only the closed reason codes
and validated numeric HTTP status described above, never provider error details or causes. Manual
native-fallback failure notifications also remain fixed and source-free. Pi core and other extensions own their own
notifications and renderers; this package cannot sanitize those upstream messages.

| Boundary | Limit |
| --- | ---: |
| Observed SSE stream | 8 MiB |
| Serialized opaque compaction item | 2 MiB |
| Persisted replacement history | 8 MiB |
| Retained user text | 64K approximate tokens by default; configurable from 8K to 128K |
| Layered summary text | `replacementTokenBudget` × 4 characters; end truncated with a marker |
| Settings file | 64 KiB |
| Transport retries | At most 2 |
| Whole-operation timeout | Default 15 minutes; at most 30 minutes |
| Stage timeout | Default 5 minutes; at most 10 minutes, capped by remaining total |

An individually oversized media item is dropped rather than making the session entry unbounded. The
oldest fitting text item may be partially truncated to preserve newer context. These hard byte
ceilings are intentionally not configurable.

## Experimental limitations

- The wire contract is undocumented and can change independently of Pi or this package.
- Full older history depends on this extension and the same compatible model. Removing the extension
  exposes only the portability fallback marker and Pi-retained recent messages.
- The package does not reproduce Codex core's context-window UUID/number lineage, previous-model
  compatibility fallback, exact pre-turn ordering, or exact mid-turn model-session ownership.
- Pi exposes no public effective-loadout snapshot. Observed, unchanged description-only rewrites
  (including codemode `mode: "on"`) can use Remote V2, but unproven transformations, hidden declarations
  (including codemode `mode: "only"`), membership/schema mismatches, unsupported tool-update shapes,
  or different serialized declaration surfaces use native compaction only without an active opaque
  boundary; otherwise they cancel. Observation
  does not bypass tool/schema equality or stale-state checks; divergent prompts require the separate
  exact two-view witness above.
- Pi invokes `session_before_compact` handlers in registration order. Another extension that mutates
  prompt, tools, or context **after this handler returns** can invalidate an already prepared opaque
  checkpoint before Pi appends it. Load such handlers before this extension or disable Remote V2 in
  that combination; the extension cannot inspect later handlers' changes.
- A layered summary is one native request over the whole dropped span. A very large span can itself
  exceed the model's window or fail, and compaction then cancels as before. The summary is lossy for
  that span; only the older opaque history is kept exactly.
- Request-local payload hooks such as priority service-tier selection are not dispatched for Remote
  V2. Ordinary and replay requests still compose those hooks in registration order. Remote V2 uses
  provider defaults, not necessarily an ordinary request's selected tier.

The [privacy/opaque-boundary rules](#privacy-storage-and-limits) apply to every path: only authorized non-opaque failures allow whole-history native fallback; an effective opaque boundary is preserved or layered, never superseded automatically, even when raw history contains both kinds. A witnessed divergent run-local prompt still compacts the canonical system state. [Settings](../README.md#settings) documents process-local write ordering and the cross-process conflict check.
