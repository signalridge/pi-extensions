# Pi LSP Guidelines

## Protocol behavior

- Return one empty configuration object per `workspace/configuration` request item for ty and Ruff.
- Allow a bounded rust-analyzer-specific grace period for a newer push diagnostic after an initially empty pull result.
- On Windows, resolve extensionless commands against the adapter's effective `PATH` and child cwd, preferring `.exe`, `.cmd` and `.bat` over npm's extensionless POSIX shim, then launch `.cmd` or `.bat` shims through `%ComSpec%` as one verbatim, quoted command line.
- Advertise every client capability statically (including `codeActionLiteralSupport` with the full kind set); a spawn-per-call client cannot follow dynamic registration.
- Route navigation and rename only to a server whose `initialize` result advertises the provider; never send a request a server did not advertise.
- Preserve per-session ownership for concurrent work sharing one adapter status key so one completion cannot clear a running sibling.

## Configuration and catalog

- Prefer canonical JSON and explicit argv arrays for configuration.
- Avoid extension-specific environment-variable settings, but retain `servers[].env` for child-process needs.
- Keep the built-in catalog limited to direct-command routes for real standalone launchers that do not overlap for any one operation (use `operations` to split a file type between servers), including required initialization, platform-wrapper behavior, and dialect-specific language IDs.
