# pi-analytics — local analytics for Pi

[![npm](https://img.shields.io/npm/v/@signalridge/pi-analytics)](https://www.npmjs.com/package/@signalridge/pi-analytics) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> [!WARNING]
> This extension is experimental. Its metrics, storage format, and dashboard may change between releases.

Healthy startup, reload, and resume do not emit an experimental warning. Storage initialization and write failures still report actionable warnings.

`@signalridge/pi-analytics` is independently publishable and opt-in: it is marked `piExtension.lifecycle: experimental`, so it is released only when a changeset names it and is never enabled for you automatically.

`@signalridge/pi-analytics` is a local-first [Pi coding agent](https://pi.dev) extension that counts model calls, skill activations, tool activity, and observed provider errors without storing conversation or tool content.

## Features

- Starts collecting settled Pi response cycles after installation with no configuration or startup I/O.
- Breaks skill activations down by explicit user invocation, model loading, provider, and model.
- Counts tool calls, failures, average duration, and model attribution.
- Reports logical LLM calls per response with average, median, P95, maximum, and distribution buckets.
- Reviews requested versus explicitly reported model IDs, with a bounded preview and searchable pair details.
- Separates HTTP 429/5xx responses, conservative connection-error categories, recovered errors, and terminal provider failures.
- Offers Today, rolling 7-day, rolling 30-day, and all-time views through one `/analytics` TUI/RPC dashboard.
- Stores only content-free metadata in private, versioned JSON Lines files.
- Uses one writer file per Pi runtime, so concurrent Pi processes never share a routine writer lock.
- Never starts a server or sends analytics anywhere.

## Install

Install persistently:

```bash
pi install npm:@signalridge/pi-analytics
```

Try the published package without installing:

```bash
pi -e npm:@signalridge/pi-analytics
```

Try a local checkout from the repository root:

```bash
pi -e ./packages/pi-analytics
```

The storage implementation uses Node's built-in filesystem APIs and has no native database dependency.

## Quick start

Complete at least one Pi response, then run:

```text
/analytics
```

The default overview covers the last seven rolling days:

```text
Analytics · Last 7 days

Response cycles                    83
LLM calls                         192
Calls per response        2.31 · P95 6
Tool calls                        414
Tool errors                         7
Skill activations                  31
Provider errors                     4
Recovered errors                    3
```

Use the menu to change the time range or browse Skills, Tools, Provider reliability, Response cycles, and Data & privacy. Only fully settled cycles are included; active work is omitted.

## Metric definitions

### Response cycles and LLM calls

A **response cycle** starts when Pi begins agent work and ends at `agent_settled`. Automatic retries, overflow-compaction recovery, tool follow-ups, and queued continuations before settlement stay in that cycle.

An **LLM call** is one logical assistant generation; idle and streaming cache-warming hooks are excluded. Successful finalized assistants establish physical model identity, which remains available throughout their tool batch. A router failure before dispatch records a terminal failure but no LLM call or physical provider/model identity. The selected router remains initial response-cycle metadata.

Provider hooks normally precede `message_start`; analytics accepts them only in the turn's pre-stream window. Pi replays the same untagged hooks for cache warming and exposes no warming-completion or request-ownership ID. After a cache-warming decision or extension reload, analytics conservatively ignores further raw request/HTTP hooks until a non-reload session start. Pi can retain an in-flight warmer across reload whose delayed callbacks reach the fresh extension runner, so even a new analytics factory cannot establish their ownership. Normal startup and new-session defaults still accept unambiguous hooks. Successful assistant generations and tool/skill attribution still count; failures without unambiguous dispatch evidence remain unattributed and do not establish an LLM call. This can undercount HTTP observations and failed dispatched calls, rather than charge ambiguous warming to assistant reliability. Providers may retry HTTP internally; these counts are not a complete network-attempt log.

### Requested and reported models

Response cycles opens a terminal-height-adaptive, read-only browse preview. The initial list shows a **Response statistics** row and at most six model pairs plus an explicit hidden-pair count; shorter terminals show fewer rows with Kit's range indicator. Page or search to reach every pair. Open **Response statistics** for an adaptive exact-document review of all original metrics, or open a pair for its full requested/reported IDs and call count. Configured navigation and paging keys apply; narrow terminals wrap and scroll rather than discard data. RPC uses bounded review and detail pages through the same menu. The selected date range applies to both views.

The requested provider/model comes from the finalized assistant's concrete dispatch, not the selected virtual router. The optional reported model comes only from native `AssistantMessage.responseModel` (already available in Pi 1.4). Missing reports, including historical records, remain **Not reported**, never inferred matches. **Same ID** means exact string equality only, not proof of backend equivalence; **Different ID** is informational, not an error. A reported model does not identify a reported provider.

Only nonblank strings of at most 256 UTF-16 code units are collected; malformed or oversized live metadata is omitted without losing the cycle. Disk validation rejects malformed fields. Display text is terminal-safe. This is metadata only: it does not change token/cost accounting, reprice usage, query a catalogue/provider, or change model/thinking selection.

### Skills

An activation is **User initiated** when an observed interactive or RPC `/skill:<name>` input is associated with an active or subsequently started response cycle. This includes skill commands queued while Pi is streaming. It is **Model initiated** when the built-in `read` tool successfully loads the exact canonical `SKILL.md` path Pi discovered. A skill is counted at most once per response cycle, and explicit user use takes precedence.

Pi does not expose a first-class skill-invocation event or a post-chain acceptance event for input observers. Non-standard loading such as `bash` plus `cat SKILL.md`, unsuccessful reads, and provider behavior invisible to Pi are not counted.

### Tools

A tool call starts at Pi's `tool_execution_start` event and finishes at `tool_execution_end`. The extension stores the tool name, model attribution, timing, completion state, and final error flag. Top-level error flags are reconciled by tool-call ID against `turn_end.toolResults`, after all `message_end` rewrites; execution durations are unchanged. Nested calls have no transcript result and retain their execution outcome. It cannot reliably distinguish another extension blocking a call from every other tool error, so both appear as errors.

### Provider reliability

Pi exposes HTTP responses and final assistant failures, not every provider-SDK transport retry. The dashboard therefore labels these values as **observed provider errors**. It reports HTTP 429 and 5xx counts; conservative DNS, timeout, connection, TLS, network, and provider categories; recovered errors; and terminal failures. Error messages are classified in memory and discarded.

## Command

```text
/analytics
```

The command accepts no arguments. TUI mode uses the full dashboard; RPC mode adapts the same standard screens to dialogs. Print and JSON modes reject the interactive command observably instead of writing ad hoc protocol output.

The root menu contains Change time range, Skills, Tools, Provider reliability, Response cycles, Data & privacy, and Close. Skills and Tools are searchable browse views with details and model breakdowns. Escape goes Back from nested screens and closes the root. Ctrl+C closes the menu. Data deletion uses Pi TUI Kit's standalone confirmation: Back keeps the dashboard open, Ctrl+C closes it in TUI mode, and cancellation never clears data.

## Local data and privacy

Current analytics live under:

```text
<pi-agent-directory>/pi-analytics/
├── current
└── generations/
    └── <opaque-generation-id>/
        └── <opaque-writer-id>.jsonl
```

The opaque IDs are storage coordination identifiers generated by the extension; they are not Pi session IDs. On Unix, directories are restricted to mode `0700` and files to `0600`. Linked storage roots, markers, and writer files are rejected. Initialization publishes a fully written, synced private marker with atomic no-replace semantics; concurrent writers never observe an empty initialization marker. A crash before publication can leave a private temporary file, which is ignored, while an actually malformed `current` marker still fails closed.

Stored fields are limited to timestamps and durations; extension-generated record IDs; requested provider/model IDs, optional explicitly reported model IDs, and thinking level; tool and skill names; user/model skill source; counts, outcomes, and completion states; HTTP status codes; and classified provider-error categories. Provider-supplied tool-call IDs are replaced with local ordinals before publication.

The extension does **not** store prompts, responses, thinking content, tool arguments or results, raw error messages, HTTP headers, cwd/project/file paths, session names or IDs, or credentials.

Each settled response is one versioned, newline-terminated frame. Frames larger than 1 MiB are dropped. Local writes receive a five-second cancellation deadline; Node filesystem cancellation is best-effort, so an operating-system request that has already begun may still finish. The extension reports the first failed or timed-out write and a later recovery without exposing filesystem errors.

`/analytics` streams and validates the active generation, checks cancellation between files and records, and periodically yields to the event loop. A crash-truncated final frame is ignored; completed malformed frames and unsupported format versions fail closed without replacing existing files.

### Clear analytics data

Choose **Data & privacy → Clear analytics data…** to atomically publish a fresh active generation. Other Pi processes observe that generation before their next write. Records racing with Clear may land immediately before or after the generation switch.

The extension then removes the previous generation. If another process still has an obsolete file in use, Clear remains logically complete and reports that physical cleanup is incomplete; stop other Pi processes and clear again. Clearing files is not a secure-erasure guarantee for underlying storage media.

## Legacy SQLite data

Versions that used Turso/SQLite stored data in:

```text
<pi-agent-directory>/pi-analytics.db
<pi-agent-directory>/pi-analytics.db-wal
```

The JSONL version deliberately does not open, import, migrate, delete, or rewrite those files, so startup cannot re-enter the old native database path. New analytics start empty.

If legacy history matters, stop every old Pi process first and preserve both files together. If it does not matter, stop every old Pi process before deleting both files manually. Never copy or remove only the main DB while an old process may still own its WAL.

## Limitations

- There are no retention settings; records remain until explicitly cleared.
- Analytics are best-effort derived metadata. A failed or interrupted local write may be omitted.
- Large all-time histories require scanning the active JSONL generation when the dashboard opens.
- Prometheus, JSON/CSV export, cloud sync, browser dashboards, token/cost reporting, and project attribution are not included.
- Statistics cover only events visible through Pi's public extension API. Cache-warming usage recorded outside normal assistant turns is not imported into this event-based store.

## Package layout

```text
packages/pi-analytics/
├── src/
│   ├── index.ts              # Thin Pi entrypoint
│   ├── analytics.ts          # Pi lifecycle, command, and session ownership
│   ├── collector.ts          # Content-free response-cycle state machine
│   ├── errors.ts             # Conservative error classification
│   ├── skills.ts             # Explicit and model skill detection
│   ├── menu.ts               # TUI/RPC analytics dashboard
│   ├── response-screen.ts    # Bounded model-pair preview and read-only details
│   ├── reported-model.ts     # Optional reported-model metadata bounds
│   ├── types.ts              # Observation records
│   └── storage/
│       ├── files.ts          # Private generations, writes, reads, and Clear
│       ├── format.ts         # Versioned JSONL codec and validation
│       ├── queries.ts        # Incremental aggregate projections
│       └── store.ts          # Lifecycle-safe storage facade
├── test/
├── README.md
├── LICENSE
├── package.json
└── tsconfig.json
```

## Upstream and local divergence

Derived from Narumiruna's `pi-extensions` analytics. This fork uses content-free JSONL response-cycle storage, conservative concrete-dispatch evidence, and an adaptive requested/reported-model review; it retains the upstream license.

## License

MIT. See [`LICENSE`](./LICENSE).
