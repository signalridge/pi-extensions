# pi-stamp — transcript metadata for Pi

[![npm](https://img.shields.io/npm/v/@signalridge/pi-stamp)](https://www.npmjs.com/package/@signalridge/pi-stamp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@signalridge/pi-stamp` is a quiet [Pi coding agent](https://pi.dev) extension that adds a
right-aligned timestamp after each user and assistant message in the interactive transcript. Opt-in
settings can add response timing, assistant provenance and usage, or tool duration and outcome.

## Features

- Shows each message's recorded creation time on a dim, right-aligned transcript row.
- Supports 12/24-hour clocks, optional seconds, automatic date context, locales, and time zones.
- Optionally shows assistant response duration and detailed first-content/total timing.
- Optionally shows reported assistant model, API/provider, stop reason, token usage, and estimated
  cost without querying a provider.
- Keeps response IDs and bounded diagnostic summaries behind explicit metadata opt-in plus Pi's
  transcript-expansion control; never includes raw diagnostics or opaque signatures.
- Optionally records tool duration and success/error after the complete tool block, paired strictly
  by tool-call ID even when tools run in parallel.
- Stores exact versioned custom session entries that survive reload and resume.
- Keeps every stamp entry outside LLM context, so stamp text is never sent to the model.
- Uses Pi's current theme, remains width-safe in narrow terminals, and owns no timer, process,
  watcher, network request, custom tool, or persistent status item.

## Install

Install from npm:

```bash
pi install npm:@signalridge/pi-stamp
```

Try without installing permanently:

```bash
pi -e npm:@signalridge/pi-stamp
```

Try this package from a local checkout:

```bash
pi -e ./packages/pi-stamp
```

## Quick start

Load the extension and use Pi normally. Each new user and assistant message receives a separate dim
stamp aligned to the terminal's right edge:

```text
Your message
                                 14:32:08

Assistant reply
                                 14:32:11
```

Run `/stamp` to open the presentation menu:

```text
Stamp
24-hour · seconds · Day changes · Invariant · Local · Timing off · Metadata off · Tool stamps hidden

Settings
Status
Help
Close
```

Settings save immediately. Mounted compatible stamps reformat on the next render, and future stamps
use the same effective values.

## Settings

The `/stamp` Settings screen provides these controls:

| Field | Accepted values | Default | Behavior |
| --- | --- | --- | --- |
| `hourCycle` | `"24h"`, `"12h"` | `"24h"` | Selects the clock style. |
| `showSeconds` | boolean | `true` | Shows or hides seconds. |
| `dateContext` | `"day-change"`, `"always"`, `"never"` | `"day-change"` | Adds a date at recorded day boundaries, every time, or never. |
| `locale` | `"invariant"`, `"system"`, or one BCP 47 tag | `"invariant"` | Controls localized date/time presentation. |
| `timeZone` | `"local"` or one supported IANA zone | `"local"` | Controls time and day-boundary interpretation; `UTC` is accepted. |
| `responseTiming` | `"off"`, `"duration"`, `"detailed"` | `"off"` | Keeps timestamps minimal, adds total assistant duration, or labels first-content and total timing. |
| `assistantMetadata` | `"off"`, `"compact"`, `"expanded"` | `"off"` | Captures and shows no assistant metadata, a compact model/total/cost summary, or all supported reported fields. |
| `toolStamps` | boolean | `false` | Records and shows duration plus success/error for newly observed tools. |

The compatibility defaults produce local `HH:mm:ss` for ordinary same-day messages. `invariant`
uses Gregorian ISO dates, Latin digits, and English `AM`/`PM`. `system` uses the operating system
locale; examples of explicit locales are `en-US`, `fr-FR`, and `zh-TW`.

The canonical user file is:

```text
~/.pi/agent/pi-stamp.json
```

Pi's configured agent directory replaces `~/.pi/agent` when applicable. The file is a partial JSON
object. This example shows 12-hour Taipei time without seconds, compact assistant metadata, and tool
stamps:

```json
{
  "hourCycle": "12h",
  "showSeconds": false,
  "timeZone": "Asia/Taipei",
  "responseTiming": "duration",
  "assistantMetadata": "compact",
  "toolStamps": true
}
```

Settings precedence is intentionally:

```text
built-in defaults -> user pi-stamp.json
```

Presentation is a personal preference, so `pi-stamp` does not read project settings or
extension-specific environment variables. Missing settings do not create a file or directory.
Updates preserve unknown fields and publish through a private temporary file plus atomic rename.
Malformed or invalid files become read-only and are never overwritten; fix the reported file and run
`/reload`. A fresh process uses defaults while the file is invalid, and a running process retains its
last valid settings.

Reads and writes are serialized within one Pi process. Separate Pi processes do not share a lock, so
concurrent saves are last-writer-wins even though each process rereads immediately before atomic
publication.

`/stamp` supports TUI and RPC dialog modes. Print and JSON command invocations reject without writing
ad hoc protocol output. Transcript stamps themselves are appended only in TUI mode.

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
claude-sonnet-4-6 · 842 tok · est $0.018
```

When Pi reports a response model different from the requested model, compact mode keeps both:

```text
requested-alias → provider-response-model · 842 tok
```

Expanded mode adds labeled rows for API, provider, requested model, provider-reported response model,
stop reason, and each individually reported input/output/reasoning/cache-read/cache-write/total token
or estimated-cost field. Missing values stay absent; `pi-stamp` never derives a token total, response
model, cost, or diagnostic message.

Pi's transcript expansion action (`app.tools.expand`, `Ctrl+O` by default) is the explicit debug view.
With assistant metadata enabled, it may additionally show the sanitized response ID and at most five
diagnostic summaries. A summary contains only diagnostic type, error name, and error code. Stamp data
never copies diagnostic messages, stacks, details, raw payloads, message content, tool arguments, or
`textSignature`, `thinkingSignature`, and `thoughtSignature` fields. Terminal controls are removed
and retained text is bounded before persistence.

Provider support varies. Every optional field is shown only when present and valid on that finalized
assistant message. The cost label says `est` because Pi's message value is an estimate based on the
provider/model usage data available to Pi; the extension performs no price lookup.

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

The tracker owns at most 256 observations in one turn. Duplicate, unmatched, malformed, backwards,
or excess observations are ignored. Pending state is cleared on a new turn, agent cancellation/end,
session replacement, reload, and shutdown. Tools that were not observed while tool stamps were
enabled are not backfilled.

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

## Limitations

- Pi does not currently expose a public decorator for built-in message or tool rows, so stamps appear
  as separate transcript rows rather than inside the original bubble/block.
- Another extension can append transcript entries at the same lifecycle boundary, so strict visual
  adjacency between independently loaded extensions is not guaranteed.
- There are no arbitrary format strings, relative labels, provider-server latency, token/cost
  estimation beyond Pi's message fields, aggregates, raw diagnostics, or analytics dashboard.

## Package layout

```text
packages/pi-stamp/
├── src/
│   ├── index.ts       # Thin Pi package entrypoint
│   ├── format.ts      # Date, clock, and response-elapsed formatting/settings types
│   ├── metadata.ts    # Bounded metadata capture, validation, and compact/expanded labels
│   ├── menu.ts        # /stamp presentation menu
│   ├── settings.ts    # Validation and atomic user settings
│   └── stamp.ts       # Entry compatibility, rendering, and lifecycle ownership
├── test/
│   ├── format.test.ts
│   ├── metadata.test.ts
│   ├── menu.test.ts
│   ├── settings.test.ts
│   ├── stamp-tool.test.ts
│   └── stamp.test.ts
├── README.md
├── LICENSE
├── package.json
└── tsconfig.json
```

## License

MIT. See [`LICENSE`](./LICENSE).
