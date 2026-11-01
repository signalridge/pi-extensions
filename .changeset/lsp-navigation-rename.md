---
"@signalridge/pi-lsp": minor
---

Add code navigation and semantic rename. `lsp_definition`, `lsp_references`, `lsp_hover` and `lsp_symbols` (file symbols, or workspace symbols with `query`) take a file plus a 1-based line and an identifier on it (or a UTF-16 column) and return workspace-relative, bounded output. `lsp_rename` previews every edit by default and writes only with `apply: true`, validating all edited files and holding Pi's file-mutation queue for each before writing any; file operations are rejected. Each operation runs on the first routed server whose `initialize` result advertises its provider, and fails naming the provider when none does. A new per-server `operations` setting restricts which tools a server is routed for; the built-in catalog adds `typescript-language-server --stdio` for TS/JS navigation and keeps Biome as the only TS/JS diagnostics and fix server.

Rename captures bounded pre-request identity/size/timestamp baselines for supported workspace paths, rejects stale or unbaselined returned targets before writing, and only reads touched secondary file contents after metadata validation. Same-length saves during server computation are detected; newly created targets fail closed. Identifier boundaries inspect Unicode code points and continuation marks while keeping UTF-16 offsets.

Advertise `codeActionLiteralSupport` with the full code-action kind set so servers such as Biome expose resolvable fix-all and organize-imports actions (adapted from narumiruna/pi-extensions `246a2cb9` and `cda5d36e`). On Windows, prefer `.exe`, `.cmd` and `.bat` launchers over npm's extensionless shim and pass batch-launcher arguments to `cmd.exe` as one quoted command line (adapted from `90bafa06`).
