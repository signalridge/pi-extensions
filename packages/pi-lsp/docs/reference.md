# pi-lsp reference

[Start with the README](../README.md).

- [Configuration](#configuration)
- [Tool changes](#tool-changes)
- [Pi tools](#pi-tools)
- [Process lifetime](#process-lifetime)
- [Cancellation and shutdown](#cancellation-and-shutdown)
- [Usage rationale](#usage-rationale)

## Configuration

If no config is provided, pi-lsp ships a broad catalog of direct-command defaults. Servers are started only when matching files are requested. pi-lsp does not download language servers, so install the commands you need and make them available on `PATH`. During no-config diagnostics, unavailable default commands are filtered before workspace discovery. If none can run, diagnostics completes successfully and reports the skipped servers. Explicitly selected or custom-configured missing commands still report an error.

| Language or format | Default server | Startup command | Extensions |
| --- | --- | --- | --- |
| JavaScript, TypeScript, JSON, CSS, GraphQL, HTML, Vue, Astro, Svelte (diagnostics and fixes) | `biome` | `biome lsp-proxy` | `.js`, `.jsx`, `.ts`, `.tsx`, `.json`, `.jsonc`, `.css`, `.graphql`, `.gql`, `.html`, `.vue`, `.astro`, `.svelte`, and module variants |
| JavaScript and TypeScript (navigation and rename) | `typescript-language-server` | `typescript-language-server --stdio` | `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts` |
| Python typing | `ty` | `ty server` | `.py`, `.pyi` |
| Python linting and fixes | `ruff` | `ruff server` | `.py`, `.pyi` |
| Rust | `rust-analyzer` | `rust-analyzer` | `.rs` |
| Go | `gopls` | `gopls` | `.go` |
| Ruby | `rubocop` | `rubocop --lsp` | `.rb`, `.rake`, `.gemspec`, `.ru` |
| Elixir | `elixir-ls` | `language_server.sh` (`language_server.bat` on Windows) | `.ex`, `.exs` |
| Zig | `zls` | `zls` | `.zig`, `.zon` |
| C# | `csharp` | `roslyn-language-server --stdio --autoLoadProjects` | `.cs`, `.csx` |
| F# | `fsharp` | `fsautocomplete` | `.fs`, `.fsi`, `.fsx`, `.fsscript` |
| Swift and Objective-C++ | `sourcekit-lsp` | `sourcekit-lsp` | `.swift`, `.mm` |
| C and C++ | `clangd` | `clangd --background-index --clang-tidy` | C/C++ source and header extensions |
| Java | `jdtls` | `jdtls` | `.java` |
| Kotlin | `kotlin-lsp` | `kotlin-lsp --stdio` | `.kt`, `.kts` |
| YAML | `yaml-language-server` | `yaml-language-server --stdio` | `.yaml`, `.yml` |
| Lua | `lua-language-server` | `lua-language-server` | `.lua` |
| PHP | `intelephense` | `intelephense --stdio` | `.php` |
| Prisma | `prisma` | `prisma-language-server --stdio` | `.prisma` |
| Dart | `dart` | `dart language-server` | `.dart` |
| OCaml | `ocaml-lsp` | `ocamllsp` | `.ml`, `.mli` |
| Bash | `bash-language-server` | `bash-language-server start` | `.sh`, `.bash` |
| Terraform | `terraform-ls` | `terraform-ls serve` | `.tf`, `.tfvars` |
| LaTeX and BibTeX | `texlab` | `texlab` | `.tex`, `.bib` |
| Gleam | `gleam` | `gleam lsp` | `.gleam` |
| Clojure | `clojure-lsp` | `clojure-lsp listen` | `.clj`, `.cljs`, `.cljc`, `.edn` |
| Nix | `nixd` | `nixd` | `.nix` |
| Typst | `tinymist` | `tinymist` | `.typ`, `.typc` |
| Haskell | `haskell-language-server` | `haskell-language-server-wrapper --lsp` | `.hs`, `.lhs` |

For example, install the Rust and Go servers with their official toolchains:

```bash
rustup component add rust-analyzer rust-src
go install golang.org/x/tools/gopls@latest
```

Ensure the Go install directory (`$GOBIN` or `$(go env GOPATH)/bin`) is also on `PATH`.

For TS/JS navigation and rename, install the TypeScript language server, which uses the
project's `typescript` package when one is installed:

```bash
npm install -g typescript-language-server typescript
```

### Which servers serve which operations

A server is routed for an operation when its file extension matches and its `operations` list
includes it (no list means every operation). Diagnostics run every routed server; `lsp_fix` needs
exactly one. Navigation and rename then start the routed servers in configured order and use the
first whose `initialize` result advertises the provider below. Servers before it are shut down
without receiving the request, and later ones are not started. If none advertises it, the call fails and names the provider, the servers that lacked it, and any
default server skipped because its command is missing. Pass `server` to skip that probing.

| Tool | Required server capability |
| --- | --- |
| `lsp_definition` | `definitionProvider` |
| `lsp_references` | `referencesProvider` |
| `lsp_hover` | `hoverProvider` |
| `lsp_symbols` | `documentSymbolProvider`, or `workspaceSymbolProvider` with `query` |
| `lsp_rename` | `renameProvider` |

In the built-in catalog, `biome` is routed for `diagnostics` and `fix` only, and
`typescript-language-server` for `definition`, `references`, `hover`, `symbols`, and `rename` only,
so TS/JS diagnostics/fixes and navigation have distinct routes. Every other built-in server is routed for every
operation and serves whichever ones it advertises. For example, `gopls` and `ty` advertise every
provider above, while `ruff` advertises only `hoverProvider` (rule documentation for `noqa`
comments); because `ty` is listed first, Python navigation uses `ty` when it is installed.

Custom config is resolved in this order:

1. `<workspace>/.pi/pi-lsp.json`, only when Pi trusts the current project
2. `~/.pi/agent/pi-lsp.json`
3. the built-in server catalog

An untrusted project's canonical and legacy files are ignored. A `root` passed to an LSP tool selects files and the server working directory; it does not grant that directory authority to provide project settings. Project settings always come from the trusted Pi session workspace.

Compatibility: user-scoped `lsp.json` and trusted project-scoped `.pi/lsp.json` remain readable with a warning and are never modified automatically; rename them to their canonical `pi-lsp.json` names. New paths take precedence when both names exist.

pi-lsp-specific environment settings have been removed. Move their values into canonical JSON:

| Removed setting | JSON replacement |
| --- | --- |
| `PI_LSP_CONFIG` inline JSON | Save the same object as user `pi-lsp.json` or trusted project `.pi/pi-lsp.json` |
| `PI_LSP_CONFIG=/path/to/file.json` | Move or copy that configuration to one of the canonical paths above |
| `PI_<SERVER>_LSP_COMMAND` | Set the server's `command` to an argv array, with one string per executable or argument |

`servers[].env` remains supported because it configures the launched LSP child process rather than pi-lsp itself.

Providing custom config replaces the default server map. The following `pi-lsp.json` example intentionally keeps five selected servers:

```json
{
  "ty": {
    "command": ["ty", "server"],
    "extensions": [".py", ".pyi"]
  },
  "ruff": {
    "command": ["ruff", "server"],
    "extensions": [".py", ".pyi"]
  },
  "biome": {
    "command": ["biome", "lsp-proxy"],
    "extensions": [
      ".astro",
      ".css",
      ".graphql",
      ".gql",
      ".html",
      ".js",
      ".jsx",
      ".json",
      ".jsonc",
      ".ts",
      ".tsx",
      ".vue"
    ]
  },
  "rust-analyzer": {
    "command": ["rust-analyzer"],
    "extensions": [".rs"],
    "pullDiagnosticsGraceMs": 5000
  },
  "gopls": {
    "command": ["gopls"],
    "extensions": [".go"]
  }
}
```

Use `servers` when you need global pi-lsp options such as timeout:

```json
{
  "timeout": 30000,
  "servers": {
    "ty": {
      "command": ["ty", "server"],
      "extensions": [".py", ".pyi"],
      "env": {
        "LSP_LOG": "debug"
      },
      "initialization": {
        "settings": {}
      },
      "skipDirectories": ["generated"]
    }
  }
}
```

Custom config replaces the built-in catalog, including its `operations` split. To keep Biome for TS/JS
diagnostics and fixes while navigating with `typescript-language-server`, list both:

```json
{
  "biome": {
    "command": ["biome", "lsp-proxy"],
    "extensions": [".js", ".jsx", ".ts", ".tsx"],
    "operations": ["diagnostics", "fix"]
  },
  "typescript-language-server": {
    "command": ["typescript-language-server", "--stdio"],
    "extensions": [".js", ".jsx", ".ts", ".tsx"],
    "operations": ["definition", "references", "hover", "symbols", "rename"]
  }
}
```

Each server entry supports:

- `command`: argv array used to start the LSP server.
- `extensions`: file extensions that should route to this server.
- `operations`: pi-lsp tools this server is routed for, named without the `lsp_` prefix:
  `diagnostics`, `fix`, `definition`, `references`, `hover`, `symbols`, `rename`. Defaults to all of
  them. An explicit `server` parameter naming a server that is not routed for the operation is an error.
- `env`: environment overrides for the LSP server process. The child inherits Pi's environment, then applies these values; an `env.PATH` value is also used to resolve `command[0]`.
- `initialization`: LSP initialization options and workspace configuration values.
- `skipDirectories`: additional directory names to exclude from recursive discovery. Explicitly requested paths remain available.
- `diagnosticsSettleMs`: positive number of milliseconds without another push-diagnostics publication before using the latest result. Defaults to `800`; the built-in intelephense route uses `4000`. The global timeout remains the upper bound.
- `pushDiagnosticsGraceMs`: positive number of milliseconds to wait for the first publication from a push-only server. It is unset by default, so a silent push-only server waits for the global timeout. The built-in Lua and Haskell routes use `3000`; Dart, Terraform, Gleam, and Tinymist use `2000`. This lets clean files finish after bounded silence without returning before a late error publication.
- `pullDiagnosticsGraceMs`: positive number of milliseconds to wait for a newer push publication after a server returns an empty pull-diagnostics result. It is unset by default; the built-in rust-analyzer route uses `5000` because initial workspace analysis can finish after an early empty pull response.

Global options:

- `timeout`: request timeout in milliseconds. Defaults to `20000`.

pi-lsp infers `languageId` from common extensions and falls back to the extension without the leading dot.

For example, run the configured Ruff server through the project's uv environment without shell-string parsing:

```json
{
  "servers": {
    "ruff": {
      "command": ["uv", "run", "--no-sync", "ruff", "server"],
      "extensions": [".py", ".pyi"]
    }
  }
}
```

## Tool changes

`lsp_format` is no longer provided. pi-lsp provides diagnostics, source code actions, navigation, and rename:

- `lsp_diagnostics`
- `lsp_fix`
- `lsp_definition`
- `lsp_references`
- `lsp_hover`
- `lsp_symbols`
- `lsp_rename`

Use project formatters or shell commands for formatting workflows.

## Pi tools

Tool output is capped at Pi's standard 2,000-line / 50 KiB limit, including multi-server diagnostic aggregates. Oversized output is saved in full to a unique private temporary file; the result includes its path and a truncation notice instead of duplicating large previews in details. These spill files remain available for subsequent reads until temporary storage is cleaned up.

### `lsp_diagnostics`

Run diagnostics through configured servers.

Parameters:

- `paths?`: files or directories to check. Defaults to the workspace root.
- `root?`: workspace root. Defaults to cwd.
- `limit?`: maximum files to open per selected server.
- `server?`: configured server name, or an array of names. Defaults to all matching servers.

### `lsp_fix`

Apply source fixes or import organization through a configured server that matches its extension. If multiple servers match, pass `server` explicitly.

Parameters:

- `path`: file to fix.
- `root?`: workspace root. Defaults to cwd.
- `kind?`: source action kind. Defaults to `source.fixAll`.
- `write?`: write fixed text back to the file. Defaults to false.
- `server?`: optional configured server name.

Writing fixes uses Pi's native file-mutation queue when available, covering the complete
read/compute/write window for cooperating tools. Immediately before a changed write,
LSP rechecks that the workspace's canonical root and directory identity are unchanged,
that the path is a regular file inside that captured boundary, and that its device,
inode, and bytes still match the snapshot sent to the server. Detected external saves,
replacements, or workspace/file symlink retargets reject the write; rerun the fix to
compute fresh edits. Preview and no-op results do not write or require this final check.
This is not filesystem locking or an atomic compare-and-swap: an external writer can
still race the final check and descriptor write.

### Navigation tools

`lsp_definition`, `lsp_references`, and `lsp_hover` take a position; `lsp_symbols` takes a file.
Each starts the first routed server that advertises the operation (see
[Which servers serve which operations](#which-servers-serve-which-operations)), opens the file, and
returns paths relative to `root` (absolute outside it). Definitions and references include the
source line of the first 100 locations; later locations print as `path:line:column`. The
standard output limit above applies to the whole result.

Position parameters:

- `path`: file to query.
- `line`: 1-based line number.
- `symbol?`: identifier on that line; the position is its first match. Append `#N` for the Nth match,
  for example `value#2`. A match must sit on identifier boundaries, so `id` does not match inside `width`.
- `column?`: 1-based column in UTF-16 code units, the unit LSP uses and `lsp_diagnostics` prints. Pass
  either `symbol` or `column`; there is no implicit default column.
- `root?`: workspace root. Defaults to cwd.
- `server?`: optional configured server name.

`lsp_references` always includes the declaration. `lsp_symbols` takes `path`, `root?`, `server?`, and
`query?`: without `query` it lists the file's symbols as a tree, each with the `line:column` of its
name; with `query` it searches workspace symbols through the server that handles `path`, which also
gives project-aware servers a project to load.

### `lsp_rename`

Rename the symbol at a position across the workspace. Takes the position parameters above plus:

- `newName`: the new name.
- `apply?`: write the edits. Defaults to false, which returns a preview of every edit
  (`line:column "old" -> "new"`, grouped by file) and writes nothing.

`lsp_rename` mutates files outside Pi's native `edit` tool, like `lsp_fix` with `write: true`, so
extensions that review or gate `edit` and `write` calls do not see these writes. Reread changed files
before editing them further. The safety checks of `lsp_fix` apply to every file the rename touches,
and the edit is validated as a whole before anything is written:

- every edited file must be a regular, valid UTF-8 file inside the workspace root whose extension
  routes to the same server; edits for other files, non-file URIs, or ranges that do not exist in the
  file reject the entire rename;
- multiple target paths with the same device/inode (including hardlinks) reject the rename before writing;
- file operations (create, rename, or delete) are not applied and reject the rename;
  pi-lsp does not advertise `resourceOperations`, so conforming servers do not send them;
- with `apply: true`, pi-lsp explicitly preflights every target's workspace containment, identity,
  and bytes before requesting any write queue. Corruption detected in that preflight leaves every
  file untouched. It then acquires **only one native file-mutation queue at a time**, in captured
  canonical-path order, rechecks freshness, identity and cancellation inside the admitted callback,
  writes that target, and releases its queue before requesting the next. Native queues resolve keys
  asynchronously; never nesting them prevents a retargeted sibling from self-waiting on a held key.
  The all-file preflight is **not atomic multi-lock admission**: a later cooperating writer can change
  a sibling after preflight, causing a partial rename. No rollback is claimed.

Before starting a server, pi-lsp inventories supported files using each candidate server's discovery
and skip-directory policy (sorted traversal, at most 10,000 supported paths overall, plus
the requested file). The bounded baseline stores identity, size, modification time and change time,
not whole-project contents. Returned targets missing that pre-request baseline, including new files
or files beyond the cap, reject the entire rename even in preview; use a smaller workspace root.
Touched files must still match their baseline before pi-lsp reads their bytes and validates ranges.
The requested file also retains its original bytes. The queued write checks then compare every
touched file's identity and bytes again. Same-length external saves are detected through timestamps,
not size alone. This relies on filesystem metadata fidelity; it is not a lock or atomic compare-and-swap.
An external writer can still race the final check or native queue-key resolution; this does not
provide atomic protection against arbitrary same-user filesystem syscalls. A failure after preflight
names files already fully updated; a failure while writing also names the current
**possibly partially modified target** separately,
even when a descriptor short-write, ENOSPC, or truncate error contains no path. No rollback is claimed.

Positions, ranges, previews and source context use UTF-16 columns with LF, CRLF and lone CR line
endings. Edits preserve all newline bytes outside the replaced ranges.

## Process lifetime

- Starts language servers only for tool calls, then shuts them down. Cleanup closes owned pipes,
  sends `SIGTERM`, and escalates to `SIGKILL` after 500 ms if the child has not exited. Tool calls
  wait for confirmed child closure, including after cancellation or protocol failure. After KILL,
  closure has a separate 500 ms confirmation deadline, even if the signal attempt returns true.
  Failed signalling (for example, permission denied) or missing confirmation reports a cleanup
  error without claiming the child was reaped. Ownership is retained across runner invocations:
  every tool call for the same adapter/launcher/environment and real workspace root stays
  blocked until confirmed close; other adapters or roots remain independent. Active calls may
  still run concurrently. An existing tool-call error takes precedence over a cleanup error. This does not manage
  descendant processes launched by a server.

## Cancellation and shutdown

Every tool owns its complete invocation, including every diagnostics route, every server probed for
a navigation capability, and queued fix or rename writes.
Tool cancellation and session shutdown abort the active client, prevent subsequent routes and
protocol steps after cancellation is observed, and reject changed writes before they start.
Session replacement and reload retire the old scope without cancelling a newer session's work.
Shutdown awaits accepted invocations, including initialization and server cleanup; a fix waiting
for Pi's mutation queue must still reach its queued callback before it can finish cancellation.
There is no separate whole-invocation shutdown deadline. Request timeouts and the bounded
process-close attempts described above still apply. Unconfirmed child closure reports a tool
cleanup error and retains the runner lease rather than claiming the process was reaped.

Cancellation is cooperative at await/route boundaries; synchronous file writes cannot be
interrupted. A completed write is not rolled back if cancellation arrives during later cleanup.
This does not cancel another tool's queued work, lock out external writers, or manage server
descendants. Status updates are TUI-only, session-owned, and best effort: an unavailable or
retired UI cannot bypass resource cleanup or replace the original operation error.

## Usage rationale

Use pi-lsp when an LSP can answer a targeted question about the files being edited faster than the
project's authoritative validation commands. It is most useful when:

- a full-project lint or typecheck is slow, but only a few files need intermediate feedback;
- structured diagnostics with exact ranges and severity are easier to act on than CLI output;
- a language server provides a useful source action such as `source.fixAll` or
  `source.organizeImports`;
- finding a definition, its references, or a type is faster and more exact through the language
  server than through text search, or a rename must follow scoping rules that text replacement cannot;
- a multi-language repository benefits from one configurable interface for targeted diagnostics.

For most repositories, first document the authoritative format, lint, typecheck, build, and test
commands in `AGENTS.md`, then enforce them with pre-commit hooks or CI where appropriate. If those
commands are already fast and reliable, pi-lsp may add little value.

A practical workflow is:

1. Use `lsp_definition`, `lsp_references`, `lsp_hover`, and `lsp_symbols` to understand code before
   changing it.
2. Use `lsp_diagnostics` during an edit only when targeted feedback is useful.
3. Optionally use `lsp_fix` for a supported server-provided source action, or `lsp_rename` for a
   semantic rename: preview it, then repeat the call with `apply: true`.
4. Before considering the task complete, run the repository's authoritative validation commands.
5. Treat pre-commit hooks and CI as the final enforcement layer.

This outcome-first framing is informed by [Eric Traut on LSP integration](https://github.com/openai/codex/issues/8745#issuecomment-3713058579).
