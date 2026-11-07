# pi-lsp — configurable language server tools for Pi

[![npm](https://img.shields.io/npm/v/@signalridge/pi-lsp)](https://www.npmjs.com/package/@signalridge/pi-lsp) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@signalridge/pi-lsp` is a native [Pi coding agent](https://pi.dev) extension that exposes diagnostics, source fixes, code navigation, and semantic rename through configurable Language Server Protocol routes.

<a id="features"></a>

The extension is language-agnostic: servers are selected by config and file extension instead of hard-coded language families.

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

<a id="command"></a>

## Quick start

1. Install the server commands you need on PATH; pi-lsp never downloads them.
2. Run `/lsp` to see configured commands and availability.
3. Navigate with definition/references/hover/symbols; request diagnostics when useful. Preview fixes/renames, then opt into writing only after review.
4. Run the repository's authoritative formatter/lint/typecheck/build/tests before completion. LSP speed/success benefits have not been benchmarked.

<a id="current-limitations"></a>

**Every call cold-starts and stops its servers.** Project-aware indexing may return incomplete references/symbols just after startup. No editor-like incremental pool or automatic diagnostics injection is provided.

**Writes bypass edit/write tool gates.** `lsp_fix(write: true)` and `lsp_rename(apply: true)` mutate files themselves. Freshness/containment checks are not filesystem locks; multi-file rename can partially write and has no rollback. Reread changed files. [Mutation and cleanup contract](docs/reference.md#pi-tools).

## Configuration

No config uses the [built-in server catalog](docs/reference.md#configuration). Custom JSON **replaces** that map, including operation splits. Trusted project `<workspace>/.pi/pi-lsp.json` wins over user `~/.pi/agent/pi-lsp.json`, then built-ins. A tool's root selects files/cwd, not settings authority. Example:

```json
{
  "timeout": 30000,
  "servers": {
    "ruff": { "command": ["uv", "run", "--no-sync", "ruff", "server"], "extensions": [".py", ".pyi"] }
  }
}
```

Global timeout defaults to 20000 ms. Commands are argv arrays; child environment is inherited then servers[].env overrides it (including PATH resolution). Canonical/legacy migration, all timing options, install examples and capability routing: [configuration reference](docs/reference.md#configuration).

## Pi tools

| Tool | Action / main inputs |
| --- | --- |
| `lsp_diagnostics` | paths?, root?, limit?, server?; all matching servers by default |
| `lsp_fix` | path, root?, kind? (source.fixAll), write? (false), server? |
| `lsp_definition`, `lsp_references`, `lsp_hover` | path, line, symbol or column, root?, server? |
| `lsp_symbols` | path, root?, server?, query? for workspace search |
| `lsp_rename` | position plus newName, apply? (false, preview) |

Lines/columns are 1-based; columns use UTF-16. Symbol matching is exact at identifier boundaries; value#2 selects its second occurrence. Navigation/rename requires advertised server capability. Rename accepts text edits only, no file operations; targets beyond the 10,000-path baseline fail even in preview. Output caps at 2,000 lines/50 KiB; overflow goes to a unique private temporary file. `lsp_format` is retired; use project formatters, not source actions as a formatting substitute. [All parameters, output and containment rules](docs/reference.md#pi-tools).

Cancellation is cooperative; synchronous writes cannot be interrupted or rolled back. Unconfirmed process close retains a runner lease and blocks equivalent calls until confirmed, not arbitrary server descendants. [Cancellation/shutdown](docs/reference.md#cancellation-and-shutdown).

## Provenance

The equivalent-file-URI diagnostic keys selectively adapt
[narumiruna/pi-extensions c23e6047759f6eb628eccf7395cac97a1fa4d47e](https://github.com/narumiruna/pi-extensions/commit/c23e6047759f6eb628eccf7395cac97a1fa4d47e).
The whole-invocation session cancellation selectively adapts
[756e1e2939eaf149fb4568a505117c3a8fbdf707](https://github.com/narumiruna/pi-extensions/commit/756e1e2939eaf149fb4568a505117c3a8fbdf707).
These are bounded adaptations, not wholesale replacements: file keys normalize drive letters
independently of the host OS while preserving escaped filename characters and non-file URI
identity; lifecycle handling retains this package's client leases, bounded close confirmation,
mutation queue/freshness checks, concurrent status ownership, and output limits.

From the same upstream, literal code-action support adapts
[246a2cb9dd63362506cc92b38c72b5dca0b10c84](https://github.com/narumiruna/pi-extensions/commit/246a2cb9dd63362506cc92b38c72b5dca0b10c84)
and [cda5d36e0ea70abd7c5be3194d123326867a196f](https://github.com/narumiruna/pi-extensions/commit/cda5d36e0ea70abd7c5be3194d123326867a196f),
keeping the first commit's full LSP 3.17 kind set rather than the second's three source kinds. Windows
launcher preference and `cmd.exe` quoting adapt
[90bafa069a387306ebdddfb43ee8254a2c1ddf1e](https://github.com/narumiruna/pi-extensions/commit/90bafa069a387306ebdddfb43ee8254a2c1ddf1e)
without a new dependency; unlike upstream, a dotted name whose suffix is not `.exe`, `.cmd`, or `.bat`
still gets Windows suffixes.

The navigation and rename tools adapt ideas from the MIT-licensed LSP integration of
[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (`packages/coding-agent/src/lsp`, commit
`1f23be9b8986237afb78aa15e91bbb57d98ce784`): addressing a position by line plus an identifier with an
optional `#N` occurrence, refusing an implicit column, showing the source line of each location, and
the `typescript-language-server --stdio` default. The local version is an independent implementation
on this package's per-call runner: it routes by advertised capabilities, previews renames unless
`apply: true` (oh-my-pi applies by default), rejects resource operations instead of applying them,
matches identifiers exactly without a case-insensitive fallback, and keeps servers per call rather
than in a persistent pool.

## License

MIT. See [`LICENSE`](./LICENSE).

<a id="package-layout"></a>

## Reference

Source entrypoint: `src/index.ts`. Detailed contracts and legacy section links:

- <a id="when-to-use-pi-lsp"></a>[Usage rationale](docs/reference.md#usage-rationale)
- <a id="which-servers-serve-which-operations"></a>[Which servers serve which operations](docs/reference.md#which-servers-serve-which-operations)
- <a id="tool-changes"></a>[Tool changes](docs/reference.md#tool-changes)
- <a id="lsp_diagnostics"></a>[`lsp_diagnostics`](docs/reference.md#lsp_diagnostics)
- <a id="lsp_fix"></a>[`lsp_fix`](docs/reference.md#lsp_fix)
- <a id="navigation-tools"></a>[Navigation tools](docs/reference.md#navigation-tools)
- <a id="lsp_rename"></a>[`lsp_rename`](docs/reference.md#lsp_rename)
- <a id="cancellation-and-shutdown"></a>[Cancellation and shutdown](docs/reference.md#cancellation-and-shutdown)
