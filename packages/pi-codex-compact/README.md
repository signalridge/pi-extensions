# pi-codex-compact — remote compaction V2 for Pi

[![npm](https://img.shields.io/npm/v/@signalridge/pi-codex-compact)](https://www.npmjs.com/package/@signalridge/pi-codex-compact) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> [!WARNING]
> This extension is experimental. It depends on an undocumented OpenAI Codex Responses wire
> contract and stores provider-specific opaque checkpoints. Keep backups of important sessions.

`@signalridge/pi-codex-compact` adds Codex Remote Compaction V2 to the
[Pi Coding Agent](https://pi.dev) for the built-in `openai-codex` OAuth provider. It replaces Pi's
plaintext summary-generation call with a server-generated opaque compaction item and safely replays
that item in later OpenAI Codex Responses requests.

<a id="features"></a>

Pi remains responsible for deciding when compaction runs, including automatic thresholds, the
built-in `/compact` command, overflow retries, retained-message selection, and append-only session
publication. This package owns the Remote V2 request, checkpoint persistence, and later payload
replay. Its separate, explicit recovery-export action can create a new session without compacting or
mutating the original.

> **Consent and portability:** new compactions send persisted canonical history, system instructions and tools to the credential-resolved Codex destination, bypassing ordinary request-local privacy hooks (native summary does too). Durable context edits are honored. Default consent is OFF; TUI asks once per operation and headless/RPC requires persistent opt-in before credentials. Opaque content cannot be inspected/selectively redacted; replay of existing checkpoints is not gated by new-compaction consent. Disabling the hook bypasses its consent and opaque-boundary protection. Keep source sessions/backups; no cross-model migration or proven live recovery is promised.

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
```

Loading the package enables the Remote V2 hook, but does **not** authorize sending canonical history.
Avoid loading a global npm installation and the local workspace at the same time.

## Quick start

1. Sign in through Pi's built-in OpenAI Codex OAuth provider.
2. Select a model whose provider is `openai-codex` and API is `openai-codex-responses`.
3. Work normally. In a UI-capable TUI, compaction asks permission to use canonical history **once**.
   Declining, cancelling, timing out, or having no suitable UI cancels compaction, not just the remote
   request. To authorize future requests explicitly, toggle **Allow canonical history** in this
   extension's Settings menu. In headless/RPC modes that persistent opt-in is required.
4. Run `/codex-compact` to inspect the effective route or choose **Compact now**.
5. After compaction, continue the session normally; compatible requests replay the opaque checkpoint.

Healthy startup, reload, and resume do not emit an experimental warning. In UI-capable modes,
a short portability warning appears once per loaded extension instance when its first remote
or layered checkpoint is committed—not on native compaction or failed/cancelled remote attempts. Invalid
settings, fallback failures, and incompatible-model warnings remain visible. Unsupported models
use Pi-native compaction only without an effective opaque boundary. With an active opaque boundary,
compaction cancels while this hook is enabled; disabling `enabled` explicitly opts out of that protection.

## Command

```text
/codex-compact
```

In TUI mode, the root menu shows whether Remote V2 is enabled, the active model, and whether a
manual compact will use **Codex Remote V2** (asking once unless canonical history is allowed) or
**Pi native**. These route labels do not override the opaque-boundary safety gate: an incompatible
or malformed active checkpoint cancels compaction while the hook is enabled. It contains:

```text
Compact now
Recovery export (new session)
Settings
Close
```

**Compact now** closes the menu before asking Pi to compact the active session. Escape or Ctrl+C
closes without compacting, and an obsolete menu cannot trigger work after session replacement or
shutdown. Deliberate SDK cancellation and caller abort do not become a red **Compaction failed**
notice; the hook's safe reason warning remains visible when applicable. Interrupting an active agent
turn is normal SDK compaction behavior, not evidence that compaction itself was cancelled. Unknown
failures still use a fixed, source-free failure notice, and throwing UI callbacks are harmless. **Settings** opens the bounded settings editor. In non-TUI modes, the command reports the
manual settings path instead of opening custom UI or compacting.

Pi's built-in `/compact` remains available and follows the same extension hook, including the
opaque-boundary safety gate on unsupported models.

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
  "allowCanonicalHistory": false,
  "requestTimeoutMs": 900000,
  "stageTimeoutMs": 300000,
  "maxRetries": 2,
  "replacementTokenBudget": 64000,
  "layeredFallback": true,
  "notifyOnFallback": true
}
```

| Setting | Default | Accepted values | Behavior  |
| --- | ---: | --- | ---  |
| `enabled` | `true` | Boolean | Use remote compaction for compatible models and protect active opaque boundaries on all models. Turning it off explicitly permits Pi-native compaction outside both safety and consent gates.  |
| `allowCanonicalHistory` | `false` | Boolean | Explicit persistent authorization to send canonical history and permit native summary fallback when no opaque boundary is active.  |
| `requestTimeoutMs` | `900000` | Integer from 30,000 to 1,800,000 ms | Hard whole-operation deadline across authentication, all folds, retries, and response-body inspection after authorization.  |
| `stageTimeoutMs` | `300000` | Integer from 30,000 to 600,000 ms | Hard deadline for authentication, one logical fold, or the layered summary, each including transport retries, body inspection and provider completion; capped by remaining total time.  |
| `maxRetries` | `2` | Integer from 0 to 2 | Retry transient provider transport failures (remote folds and the layered summary) before any fallback.  |
| `replacementTokenBudget` | `64000` | Integer from 8,000 to 128,000 tokens | Bound approximate retained user-message text beside the opaque item.  |
| `layeredFallback` | `true` | Boolean | When an eligible remote failure occurs over a valid compatible opaque checkpoint, keep it and add Pi's readable summary of only the newly dropped history instead of cancelling. `false` restores cancel-only behavior.  |
| `notifyOnFallback` | `true` | Boolean | Warn when Remote V2 fails and Pi-native compaction or a layered summary takes over. Does not suppress cancellation warnings protecting an active opaque checkpoint.  |

Use `maxRetries: 0` when deliberately diagnosing the first failure. Lower replacementTokenBudget to reduce stored history, or raise it only when needed for recent user context.

Missing fields use defaults. Settings reload on every `session_start`, including `/reload`, resume,
and fork. Menu writes apply immediately, preserve unknown JSON fields, serialize within the current
Pi process, and use a final conflict check plus same-directory atomic rename. On Unix, temporary
files use mode `0600`.

Malformed, invalid, oversized, or symlinked settings files are never overwritten. Safe defaults stay
active, and the menu provides read-only repair guidance until the file is fixed and Pi is reloaded.
Separate Pi processes do not share a mutation lock; a detected concurrent edit is rejected so the
user can reopen Settings and retry.

Neither deadline resets on incoming bytes or progress. For example, five healthy 70-second folds
can finish within the new fifteen-minute total, but an explicitly configured `requestTimeoutMs: 300000`
still limits the entire operation to five minutes. Recovery export remains one prefix request bounded
by the **smaller** of stage and total budgets, including authentication. The global limit remains eight
actual HTTP attempts across all normal folds and retries. The only additional request is the single
layered summary after an eligible remote failure, bounded by the smaller of one stage and the remaining
total; a remote attempt that exhausted the total leaves it no time, so compaction cancels.

## Recovery and diagnostics

Run `/codex-compact diagnostics` for the last operation's fixed code, stage, timeout scope and counts, without a model request or session entry. Private source-free JSONL logging is best-effort, bounded, and may drop rows; it never records prompts, history, checkpoints, URLs, credentials or provider error text. [Reason codes and log permissions/limits](docs/reference.md#safe-failure-diagnostics).

For loadout_mismatch, an authorized short unchanged ordinary request on the issuing compatible model can establish evidence before manual compaction (no intervening reload). HTTP/auth failures do not imply model mismatch; diagnose by fixed code, not guessed cause.

Recovery export is a separate explicit action for an **idle persisted TUI** with a valid compatible prior checkpoint; RPC/headless is unsupported. The read-only offer gives `/codex-compact confirm-recovery <UUID>`, valid once for five minutes in unchanged state; decline or `/codex-compact cancel-recovery` sends nothing. It creates a new session, resets copied historical usage/cost, leaves source/backups unchanged, and never switches or sends automatically. Open its reported path with `/resume`; keep the source even after success. [Eligibility, cancellation, publication races and limits](docs/reference.md#explicit-recovery-export-restricted).

## Requirements and compatibility

Only built-in openai-codex OAuth, API openai-codex-responses, a compatible active model and Remote V2 entitlement are supported. Not API-key/Azure/Copilot/arbitrary compatible providers. Pi owns threshold/manual/overflow decisions; this package owns checkpoint request/persistence/replay. Unsupported ordinary requests are not blocked and see fallback marker/recent messages; enabled compaction cancels over malformed/incompatible opaque history. Layered v2 checkpoints cannot be replayed by 1.10 or earlier. Historical Pi 1.4 offline evidence is not live backend acceptance; development pins now target 1.5. [Detailed compatibility](docs/reference.md#requirements-and-compatibility).

## License

[MIT](LICENSE)

<a id="package-layout"></a>
<a id="development"></a>

## Reference

Source entrypoint: `src/index.ts`; run `bun run check` from the repository root. Detailed contracts and legacy section links:

- <a id="bounded-full-history-folding"></a>[Bounded full-history folding](docs/reference.md#bounded-full-history-folding)
- <a id="layered-fallback-over-an-opaque-checkpoint"></a>[Layered fallback over an opaque checkpoint](docs/reference.md#layered-fallback-over-an-opaque-checkpoint)
- <a id="explicit-recovery-export-restricted"></a>[Explicit recovery export (restricted)](docs/reference.md#explicit-recovery-export-restricted)
- <a id="safe-failure-diagnostics"></a>[Safe failure diagnostics](docs/reference.md#safe-failure-diagnostics)
- <a id="source-free-diagnostics"></a>[Source-free diagnostics](docs/reference.md#source-free-diagnostics)
- <a id="relationship-to-codex-configuration"></a>[Relationship to Codex configuration](docs/reference.md#relationship-to-codex-configuration)
- <a id="how-it-works"></a>[How it works](docs/reference.md#how-it-works)
- <a id="witnessed-request-local-system-prompts"></a>[Witnessed request-local system prompts](docs/reference.md#witnessed-request-local-system-prompts)
- <a id="privacy-storage-and-limits"></a>[Privacy, storage, and limits](docs/reference.md#privacy-storage-and-limits)
- <a id="experimental-limitations"></a>[Experimental limitations](docs/reference.md#experimental-limitations)
