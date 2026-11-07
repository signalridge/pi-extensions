# pi-rules reference

[Start with the README](../README.md).

- [Parsing](#parsing)
- [Scope](#scope)
- [Sharing rule files with oh-my-pi and Cursor](#sharing-rule-files-with-oh-my-pi-and-cursor)
- [System prompt and caching](#system-prompt-and-caching)
- [Repeat policy and persistence](#repeat-policy-and-persistence)
- [Not supported](#not-supported)
- [Provenance](#provenance)

## Parsing

The frontmatter reader accepts the YAML subset rule files use — one
`key: value` per line, quoted strings, `true`/`false`, one-line `[a, b]` lists
and `- item` lists — and rejects anything else with a line number. Unlike YAML,
an unquoted value may start with `*`, so Cursor's `globs: *.ts` works. Unknown
fields, wrong types, invalid regexes and invalid globs reject the whole file;
nothing is guessed. A startup notice counts rejected files and warnings, and
`/rules` lists each one.

## Scope

`scope` tokens follow oh-my-pi's syntax:

- `tool` or `toolcall` — every checkable tool;
- `tool:edit`, `tool:write`, `tool:bash`, `tool:powershell` (or the bare name);
- `tool:edit(<glob>)`, `tool:write(<glob>)` — only calls whose `path` matches;
  `tool(<glob>)` means both.

What is checked: each `edits[].newText` of an `edit` (the replacement text, not
the text being replaced), the `content` of a `write`, the `command` of `bash`
and `powershell`. `bash` and `powershell` calls have no path, so a path glob on
them is an error, and a rule with `globs` never matches them.

Path matching mirrors Pi's exact lowercase `file://` recognition and decodes those URLs before
matching. Other spellings, such as `file:src/a.ts` or uppercase `FILE://`, remain literal paths,
not decoded URLs. Filename whitespace and escaped space/Unicode bytes remain significant.

Some oh-my-pi scope tokens name streams Pi cannot check before a call runs. They
produce a warning and are dropped, which only ever narrows where a rule fires:
`text` and `thinking` (assistant prose, see [Not supported](#not-supported)) and
tools other than the four above. A rule left with no checkable scope is
rejected.

## Sharing rule files with oh-my-pi and Cursor

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
rule's file path instead. Glob offers—including description-less rules absent from the index—and
repeated block references likewise provide the rule-file path when `read_rule` is inactive or hidden.
The extension never widens the selected tool whitelist.

## Repeat policy and persistence

A queued reminder or glob offer counts as delivered only when its own authenticated custom message
is admitted at Pi's native `message_start` boundary, not when it is queued. Pending matches are
deduplicated in memory; cancellation, settlement, branch changes and runtime retirement release
undelivered claims so a later match can offer them again. Copied message details cannot confer a
receipt. Block messages and successful `read_rule` calls retain their immediate delivery behavior. Each
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

The [five runnable examples](../README.md#examples) remain together in the entrypoint.

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
