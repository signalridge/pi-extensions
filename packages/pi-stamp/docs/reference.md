# pi-stamp reference

[Start with the README](../README.md).

- [Timestamp and response-timing semantics](#timestamp-and-response-timing-semantics)
- [Assistant provenance and usage](#assistant-provenance-and-usage)
- [Tool timing](#tool-timing)
- [Context and persistence](#context-and-persistence)
- [Selective upstream compatibility](#selective-upstream-compatibility)

## Timestamp and response-timing semantics

- A **user** stamp is the timestamp recorded when Pi creates the submitted user message.
- An **assistant** clock is the timestamp recorded when Pi creates the response stream/message.
- New assistant entries separately record when this extension observes Pi's final `message_end`.
  `responseTiming: "duration"` shows creation-to-completion elapsed time:

  ```text
  14:32:08 · 3.2s
  ```

- `responseTiming: "detailed"` distinguishes the first meaningful streamed content observed by Pi
  from total completion:

  ```text
  14:32:08 · first 0.8s · total 3.2s
  ```

  First content is the first non-empty text, thinking, or tool-call update—not a provider-server
  timestamp or guaranteed time-to-first-token. `first n/a` means Pi finalized the response without
  such an update; completion time is never substituted.
- If an assistant message invokes tools, response timing ends at the assistant's `message_end` and
  excludes tool execution even though the assistant stamp appears after the complete tool block.
- Error and aborted assistant messages use the same local completion boundary. Invalid or backwards
  clock observations degrade to timestamp-only data rather than showing a negative or clamped value.
- `dateContext: "day-change"` compares each newly recorded message stamp with its persisted
  predecessor in the selected time zone. The first known stamp stays time-only.
- Changing presentation settings re-renders compatible recorded stamps without rewriting session
  files.

Timing labels are local Pi lifecycle observations, not provider latency telemetry. They require no
network request or refresh task. Relative labels such as `3m ago` remain unavailable because they
would require periodic background refresh and lifecycle cleanup.

## Assistant provenance and usage

Assistant metadata is captured only when `assistantMetadata` is `"compact"` or `"expanded"` as the
assistant stamp is finalized. A compact stamp can look like:

```text
14:32:08 · 3.2s
claude-sonnet-4-6 · 842 tok · estimated $0.018
```

When Pi reports a response model different from the requested model, compact mode keeps both:

```text
requested-alias → provider-response-model · 842 tok
```

Expanded mode adds labeled rows for API, provider, requested model, provider-reported response model,
stop reason, and each individually reported input/output/reasoning/cache-read/cache-write/total token
or cost field. Missing values stay absent; `pi-stamp` never derives a token total, response
model, cost, or diagnostic message.

Pi's transcript expansion action (`app.tools.expand`, `Ctrl+O` by default) is the explicit debug view.
With assistant metadata enabled, it may additionally show the sanitized response ID and at most five
diagnostic summaries. A summary contains only diagnostic type, error name, and error code. Stamp data
never copies diagnostic messages, stacks, details, raw payloads, message content, tool arguments, or
`textSignature`, `thinkingSignature`, and `thoughtSignature` fields. Terminal controls are removed
and retained text is bounded before persistence.

Provider support varies. Every optional field is shown only when present and valid on that finalized
assistant message. For a valid nonnegative finite total, Pi's optional
`usage.cost.totalFromProvider` flag determines the cost label: `true` becomes `provider`, `false`
becomes `estimated`, and an absent or invalid flag becomes `unknown`. Zero is a valid total.
Missing or invalid totals establish no origin. The extension performs no price lookup or
requested-model/tier repricing. Historical version-4 snapshots keep their public `estimatedCost`
field and exact usage shape unchanged; that legacy name alone does not establish attribution.
Origin is recorded separately in optional `pi-stamp:cost-origin:v1` custom entries referencing the
exact native version-4 stamp entry ID and matching numeric cost. The renderer overlays validated
origin only in a view copy, never in persisted version-4 metadata or stored messages. Missing,
malformed, conflicting, duplicate, or off-branch annotations cannot establish attribution; without a
valid annotation the cost displays `unknown`. Lookup state retains at most 4,096 source references
and 4,096 annotation references per branch; exceeding either bound leaves origin unknown. No history
is rewritten. Older readers ignore the separate annotation and still render all version-4 timestamp,
timing, and provenance fields (including their historical cost label).

The optional annotation is appended only when the public session branch and leaf prove the exact
new stamp identity in the current session generation. If that identity cannot be established, a turn
is cancelled, or the annotation write fails, the successfully recorded version-4 stamp remains valid
and origin stays unknown. Annotation lookup is rebuilt from the active branch on start and tree
navigation and retired on replacement and shutdown.

## Tool timing

With `toolStamps: true`, the extension observes `tool_execution_start` and `tool_execution_end`,
pairs them by exact `toolCallId`, and appends entries in `turn_end.toolResults` source order:

```text
tool read · 1.3s · success
tool bash · 2.5s · error
```

The duration is the extension's local start-to-end observation. Outcome is Pi's final `isError`
state; it is not inferred from tool text. Tool arguments, output, result details, and IDs are never
shown. Because Pi's public API cannot decorate built-in tool rows, stamps appear as separate rows
after the complete tool block.

The tracker owns at most 256 top-level observations in one turn. Pi 0.99 nested tool calls
(`parentToolCallId` set) do not appear in `turn_end.toolResults`, so they are not stamped or counted
against that limit; their parent tool can still receive a stamp. Duplicate, unmatched, malformed,
backwards, or excess observations are ignored. Pending state is cleared on a new turn, agent
cancellation/end, session replacement, reload, and shutdown. Tools that were not observed while
tool stamps were enabled are not backfilled.

## Context and persistence

Stamps use Pi custom session entries. Pi renders those entries in the interactive transcript but
excludes them from model context. The extension does not modify user, assistant, or tool-result
message content.

Message entry compatibility is cumulative:

- Version 1 stores role and creation timestamp.
- Version 2 adds the previous message-stamp timestamp for live date-boundary formatting.
- Version 3 assistant entries add completion and optional first-content observations.
- Version 4 assistant entries add a sanitized metadata snapshot when metadata capture is enabled;
  timing remains optional so a valid metadata stamp survives a backwards timing clock.
- Version 1 tool entries store only bounded association/timing/outcome data.

Existing versions remain readable. Changing settings never rewrites session history. Once recorded,
a stamp survives `/reload` and session resume while the extension remains loaded. Messages and tools
created before `pi-stamp` recorded them are not backfilled because Pi's current public API cannot
insert a new custom entry into an older position in the session tree.

## Selective upstream compatibility

Formatter caching and environment refresh are adapted from narumiruna/pi-extensions commits [`bae6fea4`](https://github.com/narumiruna/pi-extensions/commit/bae6fea402b26006e9daaac3799f29274dd77bcd) and [`0b1e77d2`](https://github.com/narumiruna/pi-extensions/commit/0b1e77d2ce972c2fcefde142020be48fb43e4eb6). At most 32 date/time formatters are retained by effective locale, time zone and formatting options. Explicit environment changes and `TZ`/locale environment-variable changes are observed on the next render; OS-default changes without environment changes are checked on render at most once a minute, without a timer. Component output is deliberately not memoized, so width, theme and settings continue to be evaluated on every render. This is a bounded-construction optimization, not a measured speedup claim; entry versions and timing semantics are unchanged.
