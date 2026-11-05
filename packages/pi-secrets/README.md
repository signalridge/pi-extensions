# pi-secrets

`@signalridge/pi-secrets` keeps secret values out of the conversation Pi sends to
the model provider. Before each request it replaces every known secret in the
conversation with a deterministic placeholder such as
`$$GITHUB_TOKEN_3P8W5JH1TK2Q$$`. When the model later writes that placeholder
into a tool call, the extension puts the real value back just before the tool
runs, so a command that needs the token still works.

The package is **experimental** and opt-in.

## What it protects, and what it does not

It protects the provider-bound conversation: user, assistant and tool-result
text, extension messages, `!` command output and branch/compaction summaries as
they appear in each request. Placeholders reach the provider instead of values,
for the detected values on these covered text surfaces. Cooperating `/btw` and
`advisor` requests can also opt into the request-only projection described below.

It does **not**:

- **Stop the agent from using a secret.** Restoration is the point: a command
  the model writes with a placeholder runs with the real value, including one
  that sends it somewhere or writes it to a file. This is not a sandbox, an
  approval gate or an exfiltration filter.
- **Cover the system prompt or tool definitions.** System messages (the prompt,
  context files, skills, tool declarations) are sent unchanged. Keep secrets out
  of them.
- **Cover requests Pi or other extensions build outside the conversation hooks.**
  Compaction, branch-summary generation, export, and non-cooperating side requests
  do not pass through this transform. Their *results* are obfuscated when they
  re-enter covered conversation text; their inputs are not. This is not global
  protection and does not intercept opaque host/provider replay formats.
- **Protect child sessions that do not load it.** A tool call that starts a
  subagent is restored like any other, so the task text the child receives
  contains real values; the child's own requests are covered only when its
  extension set includes this package.
- **Redact images, files on disk or session files.** Session entries keep the
  original text; only the per-request copy is rewritten.

## Sources

Secrets are collected at session start:

| Source | What is tracked |
| --- | --- |
| Environment variables | Values of at least 8 characters whose names look secret: `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `CREDENTIAL(S)` and `APIKEY` anywhere in the name; `KEY`, `PASS`, `PWD`, `PAT`, `AUTH`, `PRIVATE` and `OAUTH` as a whole `_` segment. Names ending in a reference such as `_FILE`, `_PATH`, `_DIR`, `_SOCK`, `_URL`, `_HOST` or `_ID` are skipped. |
| URL passwords | The password in any `scheme://user:password@host` environment value, whatever the variable name, raw and percent-decoded. |
| Configuration | Literal values and regular expressions from `pi-secrets.json` (below). |
| Built-in token patterns | Vendor-prefixed credentials found in any conversation text: Anthropic, OpenAI, OpenRouter, Groq and xAI API keys; GitHub and GitLab tokens; Slack tokens and webhook URLs; AWS access key IDs and `aws_secret_access_key` values; Google API keys and OAuth access tokens; npm, Stripe, Hugging Face tokens; JWTs; PEM private-key blocks; and URL passwords that mix character classes. |

The built-in patterns are deliberately narrow: they require a vendor prefix (or,
for AWS secret keys, the setting name) and token boundaries, so identifiers such
as `token_expiry_seconds`, hashes and UUIDs stay readable. Generic bearer tokens
and high-entropy strings are not detected; add a configured pattern for a format
you use. A false positive only costs readability, because the round trip is
lossless. Discovered values are retained for literal matching for the registry's lifetime, so a
bare occurrence is protected even without the original contextual setting name.
Discovery covers all provider-bound conversation strings before any are rewritten,
so context found later in a request also protects earlier bare occurrences on that
first request.
Values shorter than 8 characters are never obfuscated.

## Placeholders

A placeholder is `$$LABEL_HASH$$`. The label names the source (the environment
variable, the configured `name`, or the pattern, for example `GITHUB_TOKEN`); it
never contains the value. The 12-character hash is an HMAC-SHA256 of the value
under a private per-installation key, so a transcript reader cannot test
candidate passwords against it. A value keeps the same safe placeholder, so
unchanged knowledge produces byte-stable requests. Before emission, labels are
checked against every relevant configured or discovered value, including normalized
letters/digits. An unsafe label becomes `SECRET`. If later discovery makes a cached
label unsafe, outgoing copies use a neutral alias; old issued tokens still restore
to their original values. Stored history is never rewritten. Hash collisions are detected and resolved to distinct
placeholders, overlapping secrets are replaced as one span, and verified placeholders
issued by this registry are treated atomically, not redacted inside their labels.
Only an unsafe label is replaced by its safe alias. Fabricated placeholder-shaped text does
not exempt secrets inside it from redaction.

The key is stored in `pi-secrets.key` in Pi's agent directory, created with mode
`0600`. The extension masks the key itself, so a tool reading the file shows a
placeholder to the model. If the file cannot be created or is invalid (it is
never overwritten), a key for the current process is used and placeholders
change after a restart; `/secrets` reports this.

A short static guideline added to the system prompt tells the model that these
tokens are redacted values to copy verbatim into tool arguments.

## Restoring tool arguments

In `tool_call`, every string inside `event.input`, at any depth, has the
placeholders this session issued replaced with their values. Unknown or altered
placeholders are left as written. Pi validated and cloned the arguments before
this hook, so the stored assistant message keeps the placeholders the model
wrote. Restoration is textual: the model quoted a placeholder, not the value, so
a value containing quote characters can change how a shell command parses.

## What you see

Tool-call rows show the arguments as the model wrote them, so they display
placeholders, not values. Tool results, your own messages and the session file
keep the original text. An approval dialog or another extension that inspects
the executed input after restoration sees the real value.

## Handler order

Pi runs handlers in extension load order, then registration order within an
extension.

- The outbound rewrite uses `context_with_system`, which runs after **every**
  `context` handler regardless of order, so text another extension adds there is
  covered. Returning the transcript with system messages untouched keeps Pi's
  system-message layout. A `context_with_system` handler of another extension
  that loads *later* sees placeholders, and anything it adds is not rewritten.
- Restoration runs in `tool_call`. Handlers of extensions loaded *earlier* see
  placeholders; those loaded later see real values. Load this package before
  extensions whose `tool_call` handlers must inspect or hash the real input.

Tool results are not rewritten in `tool_result`: Pi persists what that hook
returns, and the next request obfuscates the stored result anyway.

If the request rewrite fails unexpectedly, the extension aborts the run and
sends no conversation messages rather than an unredacted transcript. JSON tool
arguments with executable or accessor `toJSON` hooks (including inherited hooks)
are withheld without executing the hook, even if no enumerable secret was found.
An inert data key named `toJSON` remains valid JSON data.

## Optional cooperating side requests

Loading this experimental package explicitly opts into its small public
`pi.events` service, `pi-secrets:projection:v1`. Pi-btw discovers it at request time,
so either extension load order works. No Secrets service means pi-btw keeps its
existing path. A loaded but unavailable, refusing, throwing, malformed, duplicate,
or stale service withholds the side request rather than falling back to raw text.
Parent-history and destination consent remain pi-btw's responsibility.

The synchronous discovery envelope is `{ version: 1, accept }`. Secrets calls
`accept({ version: 1, project })` before the emit returns, including when the
session is unavailable. `project({ version: 1, sessionId, leafId, texts })` returns
`{ version: 1, ok: true, texts }` in the same string order, or
`{ version: 1, ok: false }`. Envelopes must be own-data-property plain/null-prototype
objects; texts must be dense plain arrays of strings. A batch is limited to 50,000
strings and 8 Mi characters (input and output). There is no async reply or retry.
Requests must name the live session and leaf. Capabilities retire at session
replacement/shutdown, and callers fence live branch ownership and cancellation.
This is a cooperative in-process contract, **not authentication** of extensions;
loaded extensions already have full process access.

All batch strings are discovered before any are projected. Cooperating callers
project full eligible history before truncation/budget slicing, then project the
assembled side request. Neither stored history nor side-thread messages change;
side replies are not blanket-restored. Only the existing native `tool_call`
boundary restores issued tokens. The coverage is limited to native conversation
requests and cooperating pi-btw `/btw`/`advisor` requests. System prompts, images,
opaque signatures, compaction generation and export remain outside this service.
Rewritten signed reasoning is not a claim of acceptance by signed providers.

## Configuration

Optional JSON files named `pi-secrets.json`:

| Scope | Location | Loaded |
| --- | --- | --- |
| User | Pi's agent directory | Always |
| Project | the project's Pi configuration directory (`.pi/`) | Only when the project is trusted |

Both apply. Each file holds a `secrets` array:

```json
{
  "secrets": [
    { "name": "Staging database", "value": "the-literal-value" },
    { "name": "Internal token", "pattern": "itk_[A-Za-z0-9]{32}", "flags": "i" }
  ]
}
```

- `value`: a literal of at least 8 characters. Keep files with literal values
  out of version control.
- `pattern`: a JavaScript regular expression; matches of at least 8 characters
  are obfuscated. `flags` may contain `i`, `m`, `s`, `u` and `v`; scanning is
  always global.
- `name`: optional label for the placeholder. A name that would reveal any known
  secret is replaced with `SECRET`.

Each entry needs exactly one of `value` or `pattern`. A missing file is empty;
invalid JSON or invalid entries are skipped with warnings that name the file
scope and entry index, never a value. Files are read once per session start.

## Command

`/secrets` reports, for the current session, how many distinct secrets are
tracked per source, which configuration files loaded, how many replacements the
last request needed, how many tool calls and placeholders were restored, and the
key status. It never shows values, placeholders or labels.

## Install

```bash
pi install npm:@signalridge/pi-secrets
```

## Use from this checkout

From the repository root:

```bash
pi -e ./packages/pi-secrets
```

## Provenance

The design is adapted from the secret obfuscation subsystem of
[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) (MIT), read at commit
`1f23be9b` (`docs/secrets.md` and `packages/coding-agent/src/secrets/`):
environment and URL-password collection, `$$LABEL_HASH$$` placeholders keyed by
a per-installation HMAC key, vendor-anchored credential patterns, and restoring
placeholders in tool arguments before execution.

This package is an independent TypeScript implementation on Pi's public
extension hooks (`context_with_system`, `tool_call`, `before_agent_start`). It
diverges from the upstream subsystem:

- configuration is JSON (`pi-secrets.json`), the project file needs project
  trust, and there is no one-way `replace` mode or case-hint suffix;
- the pattern list was rewritten and narrowed (no generic bearer-token rule) and
  environment-name matching skips reference names such as `_FILE` and `_SOCK`;
- overlapping matches are merged into one restorable span;
- cross-secret label admission and cached safe aliases preserve old restoration;
- JSON argument projections preserve own data properties (including `__proto__`),
  descriptors and frozen originals without invoking prototype setters;
- the optional synchronous projection service and pi-btw cooperation are local
  additions, not an upstream host interception mechanism;
- it never rewrites session storage and does not restore placeholders for
  display, and it covers neither native provider replay formats nor compaction
  requests, which upstream rewrites inside its own host.
