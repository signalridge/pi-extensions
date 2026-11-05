# Pi 1.5 schema qualification

These are offline qualification gates for **exactly Pi 1.5.0**, not a replacement
validator, settings catalogue, or runtime schema migration. The private root pins
`pi-schema` directly so Node can import its public compiler under isolated Bun
installs. Published extensions do not acquire a test-only runtime dependency;
host peer ranges remain `*`.

## Gates

- `bun run test:schema`: native `pi-ai.validateToolArguments` with ordinary
  TypeBox 1.3.27 and plain JSON schemas, plus real `AgentSession` tool calls
  scripted by Pi's faux provider. Invalid calls never enter the execution spy;
  schema-valid business failures enter execute but do not reach its side effect.
- `bun run typecheck:integration`: explicitly includes the compile-only
  `scripts/pi-schema-inference.fixture.ts`. Checks required/optional fields,
  numeric execute params, `defineTool`, `customTools`, and factory spreads. When
  overriding execute on a `defineTool` intersection return, the spread repeats
  `parameters` to anchor schema inference. Runtime coercion does not widen the
  static execute input to strings.
- `bun run smoke:source-schemas`: session-time source registration, first stable
  packages, then an **explicit-all** sandbox including experimental packages.
  Every registered tool schema compiles strictly, including inactive tools,
  `Agent`, and `workflow`. Representative inputs go through the host validator,
  not through execute. No provider requests are made by this source gate.
- `bun run smoke:pi`: preserves independent tarball/factory activation and the
  existing faux-provider workflow execution/recovery smoke; additionally compiles
  actual session-registered packaged schemas. Combined stable and explicitly
  opted-in experimental tarball loads run only in the isolated test process.
  It also runs the source-schema gate.

Root `check` and the test-inventory check require these gates. Factory loading,
source loading, schema compilation, and execution are separate evidence: success
in one does not imply success in the others. These tests do **not** qualify PTY,
terminal rendering, real credentials/providers, or a running installation. See
[compatibility and verification](compatibility.md) for separate CLI/PTY harnesses.

## Expected validator contract

Assertions are derived from the installed Pi 1.5 `pi-schema` README's Coercion,
Options and Values sections, its published `dist/coerce.js`, and `pi-ai`'s
`dist/utils/validation.js`, rather than snapshots of observed results:

- Numeric strings convert; integer conversions truncate fractional values toward
  zero. Boolean string conversions are case insensitive. Scalars wrap into
  arrays, but tuples do not. Required null primitives convert; an optional null
  is omitted when its schema rejects null, while nullable unions retain null.
- Union branches retain an already-valid value; otherwise the first accepted
  conversion wins. JSON `type` arrays use primitive coercion instead, so a
  nullable integer type array rejects a fractional string rather than truncating.
- Defaults are annotations, never inserted, even for missing required fields.
  Defaults and business constraints belong in execute. Frozen input/schema and
  unchanged nested transcript values remain unmodified.
- Local and recursive references work. The host deliberately rejects dangling
  references only at their location; the package qualification compiler instead
  uses `unresolvedRefs: "throw"` to catch accidental dangling package schemas.
- Extra properties follow the schema, property names are literal, tuples coerce
  their declared positions, and draft-7 additional items are not coerced. Native
  errors use escaped JSON Pointers; model-facing errors decode those segments
  into dotted paths.

## Isolation

The checked-in launcher creates a fresh short `/tmp` tree and an allowlisted
environment **before SDK import**: HOME, agent directory, XDG directories, cwd,
and temporary/cache paths are all owned test paths. Credentials are empty,
model-network refresh is disabled, and only explicit faux models are selected.
A preload denies Node network calls and filesystem mutations outside that tree,
including writes through escaping symlinks. A separate owned-child test proves
those guards reject attempts without altering the parent gate's counters.

The launcher owns the child process group and removes it and the temporary tree
on completion or interruption. Sessions emit shutdown before disposal. This is
a test-process perimeter, not a general operating-system sandbox for arbitrary
hostile subprocesses; packaging and Git fixture commands have explicit temporary
destinations. There are no live model calls, user history/config reads, installed
package reloads, or source-tree writes in the native gates.
