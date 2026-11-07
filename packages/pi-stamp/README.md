# pi-stamp — transcript metadata for Pi

[![npm](https://img.shields.io/npm/v/@signalridge/pi-stamp)](https://www.npmjs.com/package/@signalridge/pi-stamp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@signalridge/pi-stamp` is a quiet [Pi coding agent](https://pi.dev) extension that adds a
right-aligned timestamp after each user and assistant message in the interactive transcript. Opt-in
settings can add response timing, assistant provenance and usage, or tool duration and outcome.

<a id="features"></a>

Stamps use Pi's theme and fit narrow terminal widths. Entries never enter model context or modify message content. No timer, process, watcher, network request, tool or persistent status item is owned; old messages/tools are not backfilled and history is never rewritten.

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

## Timing and metadata examples

```text
14:32:08 · first 0.8s · total 3.2s
requested-alias → provider-response-model · 842 tok
tool read · 1.3s · success
tool bash · 2.5s · error
```

Assistant timing ends at local message_end, excluding tools even when displayed after their block. First content is observed nonempty text/thinking/tool update, not guaranteed provider TTFT. Missing/invalid completion timing is omitted; with valid start/end timing but no first-content timestamp, detailed mode shows `first n/a` plus total duration. Metadata/tool capture is opt-in and not backfilled. Ctrl+O (Pi expansion) shows bounded response ID/diagnostic type/name/code only when metadata is enabled, never raw diagnostics, payloads or signatures. Missing provider fields stay absent; no token total, price or response model is invented. Costs are provider/estimated only with valid reported origin, otherwise unknown—not a billing guarantee. [Timing, metadata, cost annotations and tool limits](docs/reference.md#timestamp-and-response-timing-semantics).

## Limitations

- Pi does not currently expose a public decorator for built-in message or tool rows, so stamps appear
  as separate transcript rows rather than inside the original bubble/block.
- Another extension can append transcript entries at the same lifecycle boundary, so strict visual
  adjacency between independently loaded extensions is not guaranteed.
- There are no arbitrary format strings, relative labels, provider-server latency, token/cost
  estimation beyond Pi's message fields, aggregates, raw diagnostics, or analytics dashboard.

## Selective upstream compatibility

Formatter caching/environment refresh selectively adapts narumiruna/pi-extensions; [pinned provenance and cache bounds](docs/reference.md#selective-upstream-compatibility). No measured speedup is claimed.

## License

MIT. See [`LICENSE`](./LICENSE).

<a id="package-layout"></a>

## Reference

Source entrypoint: `src/index.ts`. Detailed contracts and legacy section links:

- <a id="timestamp-and-response-timing-semantics"></a>[Timestamp and response-timing semantics](docs/reference.md#timestamp-and-response-timing-semantics)
- <a id="assistant-provenance-and-usage"></a>[Assistant provenance and usage](docs/reference.md#assistant-provenance-and-usage)
- <a id="tool-timing"></a>[Tool timing](docs/reference.md#tool-timing)
- <a id="context-and-persistence"></a>[Context and persistence](docs/reference.md#context-and-persistence)
