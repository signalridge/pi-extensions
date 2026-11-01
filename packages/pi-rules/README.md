# pi-rules

`@signalridge/pi-rules` loads rule files from the project and from the user's
Pi agent directory and hands each one to the model in the way its frontmatter
asks for:

- **always** — the rule text is part of the system prompt;
- **index** — the system prompt lists the rule's name and description, and the
  model reads the text on demand with the `read_rule` tool;
- **glob** — when a tool call touches a file matching the rule's `globs`, the
  model is told the rule exists and is asked to read it;
- **block** / **remind** — a regular-expression `condition` is checked against
  `edit`, `write`, `bash` and `powershell` arguments before the call runs. A
  `block` rule stops the call and returns the rule as the tool error; a
  `remind` rule lets the call run and steers the rule into the conversation as
  a hidden message before the next model request.

The package makes no model requests of its own. It is experimental and opt-in.

## Install

```bash
pi install npm:@signalridge/pi-rules
```

From a checkout of this repository: `pi -e ./packages/pi-rules`.

## Where rules come from

| Precedence | Location | Kind |
| --- | --- | --- |
| 1 | `.pi/rules/*.md` | project |
| 2 | `.agents/rules/*.md` | project |
| 3 | `.cursor/rules/*.mdc` | project, Cursor format |
| 4 | `<agent dir>/rules/*.md` | user |

`<agent dir>` is Pi's agent directory (`~/.pi/agent` unless
`PI_CODING_AGENT_DIR` is set). Project directories are relative to the session's
working directory; ancestors and subdirectories are not searched.

A rule's name is its file name without the extension: 1–64 letters, digits,
`.`, `_` or `-`. When two files share a name, the one with higher precedence
wins and the other is shadowed (`/rules` lists it). A file that fails to parse
still claims its name, so a broken project rule never quietly hands its name to
a user rule. A file with `enabled: false` is skipped entirely and does not claim
its name. Files are read at session start and on `/reload`; a file over 64 KiB
is rejected, and at most 200 files per directory are read, in name order.

### Project trust

Project rules are untrusted input: an always-apply rule becomes system-prompt
text and an enforced rule can stop tool calls. The three project directories are
read only when `ctx.isProjectTrusted()` is true; user rules always load.

Pi decides trust only for projects with protected resources (`.pi/settings.json`,
`.pi/extensions`, `.pi/skills`, `.agents/skills` and the others listed in Pi's
security documentation). A project whose only Pi-specific content is rule files
is treated as trusted without a prompt, the same exposure as `AGENTS.md`, which
Pi loads regardless of trust. Start Pi with `--no-approve` to keep a project's
rules out of a session. `/rules` says when project rules were skipped.

## Rule file format

A rule file is Markdown with optional frontmatter. The body after the
frontmatter is the rule text and must not be empty.

| Field | Values | Meaning |
| --- | --- | --- |
| `description` | text | Shown in the index and in glob offers. |
| `alwaysApply` | `true` / `false` | Put the rule text in the system prompt. |
| `globs` | glob or list; a string may be comma-separated | Offer the rule for matching files. On a `condition` rule, the call must also touch a matching file. |
| `condition` | regex or list of regexes | Check tool-call arguments. A leading `(?i)`, `(?m)` or `(?s)` becomes the matching JavaScript flag. |
| `scope` | tokens, comma-separated or a list | Which calls a `condition` checks (see below). Default: all four tools. |
| `enforce` | `block` / `remind` | What a `condition` match does. Default: `remind`. |
| `interruptMode` | `never`, `prose-only`, `tool-only`, `always` | oh-my-pi's name for `enforce`; use one of the two. |
| `repeatMode` | `once` / `after-gap` | When the rule's text is delivered again. Default: `once`. |
| `repeatGap` | 1–9999 | Assistant responses between deliveries for `after-gap`. Default: 10. |
| `enabled` | `true` / `false` | `false` removes the file from discovery. |

A rule's mode is decided in this order: a `condition` makes it `block` or
`remind`; otherwise `alwaysApply: true` makes it `always`; otherwise `globs`
make it `glob`; otherwise a `description` puts it in the `index`. A rule with
none of these is `manual`: it is loaded and `read_rule` returns it, but nothing
announces it.

The frontmatter reader accepts the YAML subset rule files use — one
`key: value` per line, quoted strings, `true`/`false`, one-line `[a, b]` lists
and `- item` lists — and rejects anything else with a line number. Unlike YAML,
an unquoted value may start with `*`, so Cursor's `globs: *.ts` works. Unknown
fields, wrong types, invalid regexes and invalid globs reject the whole file;
nothing is guessed. A startup notice counts rejected files and warnings, and
`/rules` lists each one.

### Scope

`scope` tokens follow oh-my-pi's syntax:

- `tool` or `toolcall` — every checkable tool;
- `tool:edit`, `tool:write`, `tool:bash`, `tool:powershell` (or the bare name);
- `tool:edit(<glob>)`, `tool:write(<glob>)` — only calls whose `path` matches;
  `tool(<glob>)` means both.

What is checked: each `edits[].newText` of an `edit` (the replacement text, not
the text being replaced), the `content` of a `write`, the `command` of `bash`
and `powershell`. `bash` and `powershell` calls have no path, so a path glob on
them is an error, and a rule with `globs` never matches them.

Some oh-my-pi scope tokens name streams Pi cannot check before a call runs. They
produce a warning and are dropped, which only ever narrows where a rule fires:
`text` and `thinking` (assistant prose, see [Not supported](#not-supported)) and
tools other than the four above. A rule left with no checkable scope is
rejected.

### Sharing rule files with oh-my-pi and Cursor

oh-my-pi's `description`, `alwaysApply`, `globs`, `condition`, `scope` and
`interruptMode` mean the same here. `interruptMode` maps onto what Pi can do
before a tool runs:

| `interruptMode` | Here | Why |
| --- | --- | --- |
| `never` | `remind` | The call runs; the rule follows as a reminder. |
| `prose-only` | `remind` | Only prose matches would interrupt, and prose is not checked, so tool matches remind. |
| `tool-only`, `always` | `block` | Pi cannot abort a model stream, but it can refuse the call before it has any effect. |

Two differences matter when sharing a file:

- oh-my-pi interrupts by default; here a rule without `interruptMode` or
  `enforce` reminds. State `interruptMode: always` if a shared rule must block.
- oh-my-pi stops interrupting once a rule has fired. Here a `block` rule blocks
  every matching call, because a retried identical call would otherwise go
  through; the repeat policy only decides whether the block message quotes the
  rule again or points at `read_rule`.

oh-my-pi's `astCondition`, `question`, `agents` and legacy `ttsr_trigger` fields
are rejected with a reason rather than ignored, because ignoring them would make
a rule fire in places its author excluded. Cursor's `.mdc` fields
(`description`, `globs`, `alwaysApply`) are read as written.

## System prompt and caching

Always-apply rules and the index are one system-prompt section, `<pi_rules>`,
set through `before_agent_start` `systemPromptOptions.sections`. Its text depends
only on the loaded files, in precedence and file-name order, with no counters or
timestamps, so it is byte-identical on every run and Pi never appends a section
patch; the provider's prompt cache keeps its prefix. Editing a rule file changes
the section after `/reload`, which costs one cache miss. Enforced and glob rules are not in the prompt
until they match. When `read_rule` is not an active tool, the index lists each
rule's file path instead.

## Repeat policy and persistence

A rule counts as delivered when pi-rules sends its text or offer (a reminder, a
block message, a glob offer) or the model reads it with `read_rule`. Each
delivery appends a `pi-rules:delivered` custom entry to the current session
branch with `pi.appendEntry`; these entries never reach the model. Repeat state
is recomputed from the current branch whenever a rule matches:

- `once`: delivered at most once per branch;
- `after-gap`: delivered again after `repeatGap` assistant responses.

Because the state lives on the branch, `/reload` and `/resume` do not deliver a
rule twice, and `/tree` navigation to a point before a delivery re-arms the
rule on that branch. Reminders are hidden custom messages of type
`pi-rules:reminder`; like any steered message they stay in the transcript and
in model context.

## Tool and command

- `read_rule` (`{ name }`) returns the text of any loaded rule. An unknown name
  returns an error listing the loaded names.
- `/rules` lists every loaded rule with its mode, source, matches since load
  and deliveries on this branch, plus shadowed and disabled files and every
  rule-file error or warning. In the TUI it opens a list; choose a rule to see
  its details. RPC clients get the same report as a notification. `/rules
  <name>` shows one rule.

## Examples

`.pi/rules/style.md`:

```markdown
---
alwaysApply: true
---
Use the repository's formatter settings; never reformat files you did not change.
```

`.pi/rules/http-handlers.md`:

```markdown
---
description: How HTTP handlers validate input and report errors
---
Validate the request body with the shared schema before touching storage, and
return errors through `problemResponse()`.
```

`.cursor/rules/react.mdc`:

```markdown
---
description: React component conventions
globs: src/**/*.tsx
alwaysApply: false
---
Function components only; colocate a component's styles in the same folder.
```

`.pi/rules/no-force-push.md`:

```markdown
---
description: Never rewrite shared history
condition: 'git\s+push\b.*(--force\b|-f\b)'
scope: tool:bash
enforce: block
---
Do not force-push. Ask the user how to reconcile the branch instead.
```

`<agent dir>/rules/ts-no-any.md`:

```markdown
---
condition: '(?:: |\bas )any\b'
scope: tool:edit(*.ts), tool:write(*.ts), tool:edit(*.tsx), tool:write(*.tsx)
interruptMode: never
repeatMode: after-gap
repeatGap: 20
---
Avoid `any`: use `unknown` and narrow it, or name the real type.
```

The package ships no built-in rules. oh-my-pi's bundled rules are
language-idiom opinions, and even generic ones would need an opt-in setting this
package otherwise has no reason to own; a copied example is a rule the user
owns and can change.

## Load order with other policy extensions

Pi runs `tool_call` handlers in extension load order and stops at the first
block. Load pi-rules before an extension that asks a human to approve calls, so
a rule blocks a call before anyone is asked about it. A reminder is sent when
pi-rules lets a call through, even if a later handler then blocks it; its text
says only that pi-rules did not stop the call.

## Not supported

- **Assistant prose (`scope: text` / `thinking`).** A prose match can only be
  acted on after the text has reached the user, by requesting one more model
  turn at `agent_before_settle`. That would make this package a continuation
  controller next to whatever controller the session already uses, and cost a
  request per match. Prose scope is dropped with a warning.
- **Mid-stream abort and retry.** Pi has no "abort this stream and retry"
  primitive distinct from the user pressing Escape. Blocking at `tool_call`
  stops a call before it has any effect, which covers tool rules.
- **AST conditions, model-judged rules and rule authoring from a complaint**
  (oh-my-pi's `astCondition`, `question` and `/omfg`).
- **Per-agent rules** (`agents`). Rules apply in every session that loads this
  extension, including child sessions another extension starts with it.
- Windsurf, Cline and Copilot instruction files, and searching ancestor
  directories.

## Provenance

The rule model is adapted from oh-my-pi
([`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi), MIT, © Mario
Zechner, Can Bölük, Stencil Labs), read at commit `1f23be9b`: its frontmatter
field names, the rule bucketing order (`docs/rulebook-matching-pipeline.md`,
`src/capability/rule-buckets.ts`), the scope token syntax and inline-flag
translation (`src/capability/rule.ts`, `src/export/ttsr.ts`), the
`once`/`after-gap` repeat policy, and the shape of its tool reminder
(`src/prompts/system/ttsr-tool-reminder.md`).

This package is an independent implementation for Pi's public extension API.
It checks rules at `tool_call` instead of watching the model stream, blocks
instead of aborting, persists delivery on the session branch instead of in a
session-manager field, reads its own strict frontmatter subset instead of YAML
with a line-based fallback, reads Pi's and Cursor's directories instead of
oh-my-pi's, and rewrites every prompt for Pi's tool names.
