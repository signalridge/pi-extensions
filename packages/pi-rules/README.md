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

The strict YAML subset accepts key/value lines, quoted strings, booleans and one-line/block lists (including unquoted *.ts). Unknown fields/types/invalid regex or glob reject the file with a line/reason; rejected names still shadow. [Parsing, scope and shared-format limits](docs/reference.md#parsing).

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

The package ships no built-in rules: copied examples are user-owned, not bundled language-idiom policy requiring a separate activation setting.

## Tool and command

- `read_rule` (`{ name }`) returns the text of any loaded rule. An unknown name
  returns an error listing the loaded names.
- `/rules` lists every loaded rule with its mode, source, matches since load
  and deliveries on this branch, plus shadowed and disabled files and every
  rule-file error or warning. In the TUI it opens a list; choose a rule to see
  its details. RPC clients get the same report as a notification. `/rules
  <name>` shows one rule.

## Safety, repeat policy and caching

No built-in rules or model requests. Always-apply/index content is stable until /reload, preserving cache prefixes. If read_rule is inactive, offers/index/repeated blocks give file paths; the extension never widens the tool whitelist. A block rule blocks **every matching call**, even after its text was delivered; repeatMode controls repeated text, not permission.

Delivery is branch-local: once or after repeatGap assistant responses. Undelivered reminders can re-arm after cancellation; authenticated native admission, not queueing, is the receipt. Reload/resume do not repeat a recorded delivery; /tree before it re-arms. Hidden reminders remain in transcript/model context. [Delivery and caching](docs/reference.md#repeat-policy-and-persistence).

Only edit replacement text, write content, bash and powershell commands are checkable. No assistant prose/thinking interruption, stream abort/retry, AST/model-judged rules or per-agent rules. Unsupported scope tokens warn and narrow; no checkable scope rejects. [Interoperability and unsupported surfaces](docs/reference.md#sharing-rule-files-with-oh-my-pi-and-cursor).

## Load order with other policy extensions

Pi runs `tool_call` handlers in extension load order and stops at the first
block. Load pi-rules before an extension that asks a human to approve calls, so
a rule blocks a call before anyone is asked about it. A reminder is sent when
pi-rules lets a call through, even if a later handler then blocks it; its text
says only that pi-rules did not stop the call.

## Provenance

Independent public-API Pi implementation adapted from [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT © Mario Zechner, Can Bölük, Stencil Labs, commit 1f23be9b. [Exact source paths and divergence](docs/reference.md#provenance); upstream notice retained in LICENSE.

## Reference

Detailed contracts and legacy section links:

- <a id="scope"></a>[Scope](docs/reference.md#scope)
- <a id="sharing-rule-files-with-oh-my-pi-and-cursor"></a>[Sharing rule files with oh-my-pi and Cursor](docs/reference.md#sharing-rule-files-with-oh-my-pi-and-cursor)
- <a id="system-prompt-and-caching"></a>[System prompt and caching](docs/reference.md#system-prompt-and-caching)
- <a id="repeat-policy-and-persistence"></a>[Repeat policy and persistence](docs/reference.md#repeat-policy-and-persistence)
- <a id="not-supported"></a>[Not supported](docs/reference.md#not-supported)
