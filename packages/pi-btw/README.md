# pi-btw — side questions for the Pi coding agent

[![npm](https://img.shields.io/npm/v/@signalridge/pi-btw)](https://www.npmjs.com/package/@signalridge/pi-btw) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@signalridge/pi-btw` is a native [Pi coding agent](https://pi.dev) extension that adds `/btw`, a side-question command for quick clarifications that should not interrupt or pollute the main agent conversation.

<a id="features"></a>
<a id="why-use-pi-btw"></a>

Use it when you want to ask a temporary question, inspect context, or get a short explanation while keeping the primary coding task focused.

## Install

```bash
pi install npm:@signalridge/pi-btw
```

Try without installing permanently:

```bash
pi -e npm:@signalridge/pi-btw
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-btw
```

## Usage

```text
/btw
/btw what does this TypeScript error mean?
/btw --with-parent=anthropic/claude-sonnet-4-5 What did the previous tool output mean?
```

Bare /btw opens Start side thread, Resume side thread and Settings; /btw <question> always starts fresh. Resume lists titled non-empty in-memory threads by latest answer/error; duplicate titles keep distinct IDs. Type follow-ups and Enter; while answering they queue as Steering and run sequentially. Shift+Tab (or Pi's thinking shortcut) changes only the side thread. Ctrl+C cancels the answer and discards draft/steering queue.

The full-screen side view suspends main rendering, not main work; primary mouse drag uses Pi clipboard copying. Ctrl+R after a successful answer brings latest question/answer, question-to-end suffix, exact range or whole thread into the main editor for review—**never automatic send**. Append is the default for an existing draft; Replace requires a second destructive confirmation. Esc returns, Ctrl+C cancels. Closing without bring adds nothing to the main conversation. Threads/errors are ephemeral, not persisted across reload/session/process replacement. [Selection, editor recovery and async ownership](docs/reference.md#usage).

## Parent history and privacy

Pi's parent `context` hooks can redact messages before the parent provider request, but Pi does not
expose that post-hook provider-visible snapshot to `/btw`. Even Pi's session projection can contain
material removed by a parent hook. **By default, `/btw` does not read or send the parent transcript
or system prompt**; this applies to direct questions, the empty composer, steering, Resume, and
virtual routing. The side provider receives only the current side question and successful messages
in this side thread.

To knowingly include **unfiltered** parent history in **one request**, prefix that question with the
exact selected physical `provider/model-id`:

```text
/btw --with-parent=anthropic/claude-sonnet-4-5 What did the previous tool output mean?
```

In the `/btw` composer, use the same prefix without `/btw`; each follow-up or queued steering
question needs its **own** prefix. For an authorized request, the prefix is stripped from the
question and side transcript. An invalid prefix can appear in a local error turn. The parent snapshot
is taken immediately before that request, capped at about 40,000 characters, and is not stored for
later side requests. It may contain raw user and assistant messages, tool calls and results, Bash
output, and summaries **without the parent `context` hook's redactions**. Do not opt in for a
destination you do not trust.

The prefix must match the model actually selected after credential fallback, not merely the model
written in `pi-btw.json`. A mismatch or malformed prefix fails that side turn **without a provider
request**; retry with the selected model. A virtual model cannot opt in because its physical
destination is chosen only at dispatch. An auth-resolved endpoint override also cannot opt in: a model
name alone does not authorize sharing with a changed endpoint. There is no persistent parent-history
setting or blanket grant. After any opted-in parent-history question, that side thread is bound to
the physical model and effective endpoint that received it. Later questions to a different model,
provider, or endpoint fail locally even with a new opt-in; start a fresh `/btw` thread instead. This
prevents a previous *side-thread answer* that echoed private context from reaching a different
provider. Same-destination follow-ups remain available without sharing the parent transcript again.

If optional pi-secrets is loaded, its synchronous request-copy projection works in either load order; a refusing/malformed/stale service blocks the request, never raw fallback. No service leaves this path unchanged. Other parent hooks, system prompts, images, opaque signatures, compaction/export remain uncovered; sharing/destination consent still applies. [Projection protocol, bounds and serialization](docs/reference.md#optional-secrets-cooperation).

## Model and thinking level

By default, `/btw` uses the current session model. To use an independent model for side
questions, create:

```text
$PI_CODING_AGENT_DIR/pi-btw.json
```

The normal location is `~/.pi/agent/pi-btw.json`. `PI_CODING_AGENT_DIR` is an existing Pi
setting; pi-btw does not add any environment variables.

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "low",
  "rememberThinkingLevelChanges": true
}
```

The `model` value uses `provider/model-id` format. Only the first `/` is the separator, so
model IDs may contain additional slashes, such as `openrouter/anthropic/claude-sonnet`.
The configured model must exist in Pi's model registry. Physical models need usable
credentials; if one cannot be found or authenticated, pi-btw warns and falls back to the
current session model. On Pi 0.99.1+, opt-in virtual models route side questions through
Pi's model registry, which selects a physical model and resolves its credentials when each
request starts. Routing or target-provider auth failures appear as side-thread errors rather
than triggering model fallback. Older Pi hosts cannot route a virtual model and report an
explicit error instead. If neither physical model is available, `/btw` reports an error and
stops. This selection affects only `/btw`; it does not change the main session model.

Pi calls its reasoning setting the **thinking level**. `thinkingLevel` sets pi-btw's starting
level; accepted values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. When the
field is absent for backward compatibility, the next invocation starts from the current session
level. The initial value and shortcut cycle are clamped to the selected side model's capabilities
using Pi's model rules. Pi-btw does not read, write, or change the main session's
`defaultThinkingLevel`.

`rememberThinkingLevelChanges` controls only persistence and defaults to `true` when omitted. A
side-thread shortcut always changes that side thread immediately. When remembering is on, the
concrete level is written for the next invocation; when off, `pi-btw.json` stays unchanged. If a
shortcut write fails, the local change remains active and pi-btw warns that it was not remembered.
A failed Settings-screen save instead restores the previous displayed value.

A missing settings file is not created until an explicit or remembered change. Files must be valid UTF-8 and ≤64 KiB; invalid files are never rewritten. Invocation-time rereads apply edits without reload except startup-only advisorModel. [Atomic-save and concurrency rules](docs/reference.md#settings-writes).

## Advisor tool

`/btw` is a side channel you open yourself. The optional `advisor` tool is its model-invoked
counterpart: the main model calls it to ask a stronger reviewer model for a second opinion on its
current work, without you leaving the main thread. The reviewer's answer comes back as the tool
result. The tool does not exist unless you name a reviewer, so installs without the setting are
unchanged.

### Enable and disable

Add `advisorModel` to `pi-btw.json`, in the same `provider/model-id` format as `model`:

```json
{
  "advisorModel": "anthropic/claude-opus-4-5"
}
```

When a session starts, pi-btw registers `advisor` only if all of these hold:

- `pi-btw.json` is valid and names `advisorModel`. An invalid file leaves the tool unregistered;
  `/btw` reports why the file was rejected.
- The reviewer exists in Pi's model registry and is a physical model. An unknown or virtual
  reviewer produces a startup warning instead of a tool.
- The session has an attached client (TUI or RPC). Print and JSON runs, and managed subagent child
  sessions, which run without one, never see the tool.

The setting is read once per session, not per call. To disable the tool, remove `advisorModel`
and run `/reload` or start a new session.

### What is sent where

`advisor` takes one optional `question` of up to 2,000 characters. On **every** call, the
reviewer's provider receives a reviewer system prompt and a single message containing that
question and a text transcript of the **current session branch**: user and assistant messages,
tool calls with their arguments, tool results, Bash output, and compaction and branch summaries,
taken from Pi's session projection and capped at the most recent ~40,000 characters. This is the
same serialization `/btw --with-parent` uses. Images, thinking blocks, the main system prompt and
tool declarations are not included. As with `--with-parent`, the transcript is **unfiltered**:
redactions made by parent `context` hooks are not applied. Setting `advisorModel` is your standing
consent to send it to that destination on each call, so configure only a reviewer you would trust
with the transcript.

pi-btw applies the same destination rules as `--with-parent`: a virtual reviewer, whose physical
destination is chosen only at dispatch, and a reviewer whose credentials resolve a different
endpoint than its registered base URL are refused without a request. The request declares no
tools, so the reviewer cannot call tools, including `advisor` itself. It uses its own provider
session ID, one UUID per session, never the main session's ID, so consecutive consultations can
reuse the reviewer's prompt cache without sharing the main conversation's cache or connection.

`advisor` refuses when the current session model is the reviewer: a model reviewing its own
transcript costs a request without adding an independent opinion. Switch the main model or name a
different reviewer. The reviewer uses the session's current thinking level, clamped to what the
reviewer model supports.

### Results and cost

A successful call returns the reviewer's text, capped at 12,000 characters, with the reviewer's
`provider/model-id`, thinking level and token usage in the result details. The usage is also
reported as the tool's nested usage, so Pi includes it in session totals. Missing credentials, a
provider error, an empty or malformed reply, or cancellation through the tool call's abort signal
returns an error result; no answer is ever substituted.

Each call is a full request billed by the reviewer's provider: up to ~40,000 characters (roughly
10,000 tokens) of input plus the reviewer's output, typically on a more expensive model than the
main one. The main model decides when to call it; the tool's guidelines ask it to consult once per
decision, before committing to an approach, when stuck, or before declaring complex work done.

## Provenance

Provider thread identity selectively adapts [narumiruna 81be3f7](https://github.com/narumiruna/pi-extensions/commit/81be3f7250b26bfd4d51ab20d193b5edae70e688): independent per-thread UUIDs, never the parent session ID. Resume picker adaptations retain local fullscreen/privacy/provider hardening. Advisor adapts MIT-licensed juicesharp/rpiv-advisor. [Pinned adaptations and divergence](docs/reference.md#provenance).

## License

MIT. See [`LICENSE`](./LICENSE).

<a id="package-layout"></a>

## Reference

Source entrypoint: `src/index.ts`. Detailed contracts and legacy section links:

- <a id="selective-upstream-compatibility"></a>[Selective upstream compatibility](docs/reference.md#selective-upstream-compatibility)
- <a id="optional-secrets-cooperation"></a>[Optional Secrets cooperation](docs/reference.md#optional-secrets-cooperation)
