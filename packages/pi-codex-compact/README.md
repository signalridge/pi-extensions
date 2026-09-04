# pi-codex-compact — remote compaction V2 for Pi

[![npm](https://img.shields.io/npm/v/@signalridge/pi-codex-compact)](https://www.npmjs.com/package/@signalridge/pi-codex-compact) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> [!WARNING]
> This extension is experimental. It depends on an undocumented OpenAI Codex Responses wire
> contract and stores provider-specific opaque checkpoints. Keep backups of important sessions.

`@signalridge/pi-codex-compact` adds Codex Remote Compaction V2 to the
[Pi Coding Agent](https://pi.dev) for the built-in `openai-codex` OAuth provider. It replaces Pi's
plaintext summary-generation call with a server-generated opaque compaction item and safely replays
that item in later OpenAI Codex Responses requests.

Pi remains responsible for deciding when compaction runs, including automatic thresholds, the
built-in `/compact` command, overflow retries, retained-message selection, and append-only session
publication. This package owns only the Remote V2 request, checkpoint persistence, and later payload
replay.

## Features

- Uses the active `openai-codex` OAuth credentials without persisting tokens or request headers.
- Handles Pi's manual, threshold, and overflow compaction reasons through the same lifecycle hook.
- Validates one bounded opaque `compaction` item from a completed Responses SSE stream.
- Persists a versioned checkpoint in `CompactionEntry.details` and restores it after reload, resume,
  or a fork that retains the checkpoint.
- Replays the newest compatible checkpoint while preserving later conversation and extension-added
  context.
- Supports repeated compaction by carrying the previous opaque item into the next Remote V2 request.
- Falls back to Pi's native plaintext compaction after authentication, transport, protocol, or
  validation failure; user cancellation does not launch the fallback.
- Provides `/codex-compact` for manual compaction, effective-route visibility, and bounded settings.

## Install

Install persistently from npm:

```bash
pi install npm:@signalridge/pi-codex-compact
```

Try the published package without installing:

```bash
pi -e npm:@signalridge/pi-codex-compact
```

Try a local checkout from the repository root:

```bash
pi -e ./packages/pi-codex-compact
# or
just try codex-compact
```

Loading the package enables Remote V2 with safe defaults. Avoid loading a global npm installation
and the local workspace at the same time.

## Quick start

1. Sign in through Pi's built-in OpenAI Codex OAuth provider.
2. Select a model whose provider is `openai-codex` and API is `openai-codex-responses`.
3. Work normally. Pi's automatic compaction and built-in `/compact` continue to operate.
4. Run `/codex-compact` to inspect the effective route or choose **Compact now**.
5. After compaction, continue the session normally; compatible requests replay the opaque checkpoint.

The extension shows an experimental warning at session start in UI-capable modes. When the active
model is unsupported, compaction remains entirely Pi-native.

## Command

```text
/codex-compact
```

In TUI mode, the root menu shows whether Remote V2 is enabled, the active model, and whether a
manual compact will use **Codex Remote V2** or **Pi native**. It contains:

```text
Compact now
Settings
Close
```

**Compact now** closes the menu before asking Pi to compact the active session. Escape or Ctrl+C
closes without compacting, and an obsolete menu cannot trigger work after session replacement or
shutdown. **Settings** opens the bounded settings editor. In non-TUI modes, the command reports the
manual settings path instead of opening custom UI or compacting.

Pi's built-in `/compact` remains available and follows the same extension hook when the active model
is compatible.

## Settings

The extension has one optional, global-only JSON settings file:

```text
<getAgentDir()>/pi-codex-compact.json
```

The normal path is `~/.pi/agent/pi-codex-compact.json`. There is no environment-variable or
project-level override.

```json
{
  "enabled": true,
  "requestTimeoutMs": 300000,
  "maxRetries": 2,
  "replacementTokenBudget": 64000,
  "notifyOnFallback": true
}
```

| Setting | Default | Accepted values | Behavior | Recommendation |
| --- | ---: | --- | --- | --- |
| `enabled` | `true` | Boolean | Attempt Remote V2 for a compatible model. | Keep enabled unless diagnosing provider behavior. |
| `requestTimeoutMs` | `300000` | Integer from 30,000 to 600,000 ms | Bound one extension-owned remote request. | Keep five minutes; increase only for a consistently slow connection. |
| `maxRetries` | `2` | Integer from 0 to 2 | Retry transient provider transport failures before Pi fallback. | Keep two; use zero when diagnosing the first failure. |
| `replacementTokenBudget` | `64000` | Integer from 8,000 to 128,000 tokens | Bound approximate retained user-message text beside the opaque item. | Keep 64K; lower it to reduce session size or raise it only when recent user context is being lost. |
| `notifyOnFallback` | `true` | Boolean | Warn when Remote V2 fails and Pi-native compaction takes over. | Keep enabled so silent fallback does not hide protocol or entitlement problems. |

Missing fields use defaults. Settings reload on every `session_start`, including `/reload`, resume,
and fork. Menu writes apply immediately, preserve unknown JSON fields, serialize within the current
Pi process, and use a final conflict check plus same-directory atomic rename. On Unix, temporary
files use mode `0600`.

Malformed, invalid, oversized, or symlinked settings files are never overwritten. Safe defaults stay
active, and the menu provides read-only repair guidance until the file is fixed and Pi is reloaded.
Separate Pi processes do not share a mutation lock; a detected concurrent edit is rejected so the
user can reopen Settings and retry.

### Relationship to Codex configuration

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

OpenAI API-key, Azure, GitHub Copilot, proxies, and arbitrary Responses-compatible providers are not
supported. Switching to another provider or model leaves Pi's visible fallback marker plus retained
recent messages in context. Switching back to the checkpoint's original compatible model restores
opaque replay.

## How it works

1. Pi prepares compaction and selects the recent message suffix it will retain.
2. The extension projects an earlier compatible checkpoint, if present, into the current Responses
   input.
3. It appends exactly one final `compaction_trigger` and sends a normal authenticated Codex Responses
   SSE request with cache retention disabled.
4. It requires a completed response containing exactly one non-empty opaque `compaction` item.
5. It constructs bounded replacement history from recent raw user-role Responses items followed by
   the opaque item.
6. It stores that history and fingerprints of Pi's retained suffix in versioned
   `CompactionEntry.details`.
7. On later compatible requests, it replaces an exactly validated marker with the persisted
   replacement history immediately before provider dispatch.

If fingerprints, model identity, payload shape, or marker count do not match exactly, the extension
leaves Pi's visible fallback context unchanged instead of guessing.

## Privacy, storage, and limits

Remote compaction sends the active conversation context, system prompt, and active tool schemas to
the same OpenAI Codex backend used by the selected model. The Pi session stores the encrypted
compaction item and bounded recent user-role Responses items. It does not store OAuth tokens,
authorization headers, or request headers in checkpoint details.

| Boundary | Limit |
| --- | ---: |
| Observed SSE stream | 8 MiB |
| Serialized opaque compaction item | 2 MiB |
| Persisted replacement history | 8 MiB |
| Retained user text | 64K approximate tokens by default; configurable from 8K to 128K |
| Settings file | 64 KiB |
| Transport retries | At most 2 |
| Request timeout | At most 10 minutes |

An individually oversized media item is dropped rather than making the session entry unbounded. The
oldest fitting text item may be partially truncated to preserve newer context. These hard byte
ceilings are intentionally not configurable.

## Experimental limitations

- The wire contract is undocumented and can change independently of Pi or this package.
- Full older history depends on this extension and the same compatible model. Removing the extension
  exposes only the portability fallback marker and Pi-retained recent messages.
- The package does not reproduce Codex core's context-window UUID/number lineage, previous-model
  compatibility fallback, exact pre-turn ordering, or exact mid-turn model-session ownership.
- Remote failure falls back to Pi's plaintext summary, so a session can contain both remote opaque
  and native compaction entries over time.
- Settings concurrency is coordinated only within one Pi process; separate processes rely on the
  final conflict check.

## Package layout

```text
src/index.ts          Thin Pi entrypoint
src/codex-compact.ts  Pi lifecycle, command, provider projection, and fallback
src/remote.ts         Provider stream invocation, auth payload, timeout, and retry controls
src/protocol.ts       Bounded SSE parsing and Remote V2 payload/output validation
src/checkpoint.ts     Replacement history, fingerprints, persistence, and replay projection
src/settings.ts       Global settings validation and atomic persistence
src/settings-menu.ts  Manual compaction and settings TUI

test/                 Protocol, checkpoint, lifecycle, remote, settings, and menu coverage
```

## Development

From the repository root:

```bash
npm --workspace @signalridge/pi-codex-compact run check
npm test
just pack codex-compact
```

The checkpoint and remote protocol boundaries are documented in `src/checkpoint.ts` and `src/remote.ts`.

## License

[MIT](LICENSE)
