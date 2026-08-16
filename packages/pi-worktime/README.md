# pi-worktime

`@signalridge/pi-worktime` tracks active agent time for the current prompt. It
accumulates only the spans between `agent_start` and `agent_end`, and resets when
an accepted user message starts (`message_start` with `message.role === "user"`).
Preflight `input` is intentionally not used, so rejected or handled input does
not erase the current worktime. The current value is exposed through Pi's
namespaced `worktime:update` event.

In TUI sessions it owns the `worktime` status key with a compact value such as
`2m 5s`. The `/worktime` command reports the same value when Pi provides a UI.
There is no persistence or settings file; print, JSON, and RPC sessions still
receive validated event-bus updates without invoking TUI-only status APIs.

## Install

```bash
pi install npm:@signalridge/pi-worktime
```

## Use from this checkout

From the repository root:

```bash
pi -e ./packages/pi-worktime
```

## Public imports

The package exports typed source entrypoints for both extension loading and
library consumers:

```ts
import worktime, { WORKTIME_UPDATE_EVENT } from "@signalridge/pi-worktime";
import {
  parseWorktimeUpdatePayload,
  type WorktimeUpdatePayload,
} from "@signalridge/pi-worktime/events";
```

## Event contract

Consumers can subscribe to `worktime:update` through `pi.events`. Payloads are
immutable exact objects of the following shape:

```ts
{ ms: number; running: boolean }
```

`ms` is finite and nonnegative. `parseWorktimeUpdatePayload()` returns a fresh
frozen normalized payload or `undefined`; `isWorktimeUpdatePayload()` validates
without executing accessors and rejects proxies, extra keys, and invalid values.

## Provenance

The active-span behavior and compact formatter are adapted from tomsej's
MIT-licensed `extensions/worktime` extension in
[`tomsej/pi-ext`](https://github.com/tomsej/pi-ext), original worktime commit
`204182c`. This package is an independent TypeScript implementation with
session-safe lifecycle handling, validated immutable events, and TUI/headless
guards.
