# pi-lsp — configurable language server tools for Pi

[![npm](https://img.shields.io/npm/v/@signalridge/pi-lsp)](https://www.npmjs.com/package/@signalridge/pi-lsp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@signalridge/pi-lsp` is a native [Pi coding agent](https://pi.dev) extension that exposes diagnostics and source-fix tools through configurable Language Server Protocol routes.

The extension is language-agnostic: servers are selected by config and file extension instead of hard-coded language families.

## Features

- Configure LSP servers with simple JSON keyed by server name.
- Routes diagnostics and source fixes by configured file extensions.
- Supports multiple servers for the same extension, for example `ty` and `ruff` for `.py`/`.pyi` diagnostics.
- Uses one internal LSP runner for JSON-RPC framing, subprocess lifecycle, diagnostics, code actions, and workspace edit application.
- Supports workspace roots, file limits, recursive file discovery, server overrides, and write-or-preview edits.
- Starts language servers only for tool calls, then shuts them down.
- Shows statusline activity only while LSP tools are running.

## When to use pi-lsp

Use pi-lsp when an LSP can answer a targeted question about the files being edited faster than the
project's authoritative validation commands. It is most useful when:

- a full-project lint or typecheck is slow, but only a few files need intermediate feedback;
- structured diagnostics with exact ranges and severity are easier to act on than CLI output;
- a language server provides a useful source action such as `source.fixAll` or
  `source.organizeImports`;
- a multi-language repository benefits from one configurable interface for targeted diagnostics.

For most repositories, first document the authoritative format, lint, typecheck, build, and test
commands in `AGENTS.md`, then enforce them with pre-commit hooks or CI where appropriate. If those
commands are already fast and reliable, pi-lsp may add little value.

A practical workflow is:

1. Use `lsp_diagnostics` during an edit only when targeted feedback is useful.
2. Optionally use `lsp_fix` for a supported server-provided source action.
3. Before considering the task complete, run the repository's authoritative validation commands.
4. Treat pre-commit hooks and CI as the final enforcement layer.

### Current limitations

- Diagnostics are not continuously injected into the conversation; the agent must call
  `lsp_diagnostics`.
- Language servers start and stop for each tool call, so pi-lsp does not retain an editor-like
  incremental session.
- The current tools expose diagnostics and source code actions, not symbol navigation, references,
  or semantic rename.
- A clean LSP result does not replace the project's formatter, linter, type checker, build, or tests.
- This project has not yet demonstrated through benchmarks that LSP improves agent task success,
  latency, or tool usage.

This outcome-first framing is informed by
[Eric Traut's comment on LSP integration for coding agents](https://github.com/openai/codex/issues/8745#issuecomment-3713058579):
the protocol was not designed specifically for coding agents, and repository-native checks may
already provide much of the desired verification value.

## Install

```bash
pi install npm:@signalridge/pi-lsp
```

Try without installing permanently:

```bash
pi -e npm:@signalridge/pi-lsp
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-lsp
```

## Configuration

If no config is provided, pi-lsp ships a broad catalog of direct-command defaults. Servers are started only when matching files are requested. pi-lsp does not download language servers, so install the commands you need and make them available on `PATH`. During no-config diagnostics, unavailable default commands are filtered before workspace discovery. If none can run, diagnostics completes successfully and reports the skipped servers. Explicitly selected or custom-configured missing commands still report an error.

| Language or format | Default server | Startup command | Extensions |
| --- | --- | --- | --- |
| JavaScript, TypeScript, JSON, CSS, GraphQL, HTML, Vue, Astro, Svelte | `biome` | `biome lsp-proxy` | `.js`, `.jsx`, `.ts`, `.tsx`, `.json`, `.jsonc`, `.css`, `.graphql`, `.gql`, `.html`, `.vue`, `.astro`, `.svelte`, and module variants |
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

Each server entry supports:

- `command`: argv array used to start the LSP server.
- `extensions`: file extensions that should route to this server.
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

`lsp_format` is no longer provided. pi-lsp now focuses on LSP diagnostics and source code actions:

- `lsp_diagnostics`
- `lsp_fix`

Use project formatters or shell commands for formatting workflows.

## Pi tools

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

## Command

```text
/lsp
```

Shows configured LSP commands and whether each command is available on `PATH`.

## Package layout

```txt
packages/pi-lsp/
├── src/
│   ├── index.ts
│   ├── adapters.ts
│   ├── command.ts
│   ├── files.ts
│   ├── lsp-client.ts
│   ├── pi-lsp.ts
│   ├── routes.ts
│   ├── runner.ts
│   ├── text-edits.ts
│   └── types.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

## License

MIT. See [`LICENSE`](./LICENSE).
