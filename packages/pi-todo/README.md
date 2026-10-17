# @signalridge/pi-todo

Experimental, opt-in Pi extension. One checklist belongs to the **current session branch**, not a project backlog, scheduler, or Goal. Nothing is inferred from workflow prose, checkboxes, or agent completion. Requires Pi's public extension and terminal UI APIs; tested against Pi 1.0.4.

## Use

Load this package explicitly with Pi's package settings or `pi --extension ./packages/pi-todo/src/index.ts` from a checkout. It is not enabled by default. The ordinary factory-registered model tool is `todo`, in namespace `tasks`, and is usable by default when the package is explicitly loaded. Initial selections such as `--tools read,write,todo`, `defaultTools: ["+todo"]`, and SDK `tools` work before session startup. This extension never calls `setActiveTools`: earlier/later startup restrictions and Plan/blocking policy remain in effect. Human `/todo` edits do not activate tools or alter tool policy.

Pi may reject duplicate static tool registrations itself. At runtime this package fails closed when a **different effective** `todo` definition is publicly visible, checking actual parameters and source provenance, not just instructions. Public discovery cannot enumerate definitions excluded by a host allowlist (including `tools: []`), or definitions rejected/overridden before startup. This is not a guarantee to detect every hidden static collision. The human command remains available when the tool is excluded; no automatic aliases or renamed tools are created.

Tool calls:

```json
{"action":"list"}
{"action":"add","baseRevision":0,"title":"Verify behavior","description":"Run focused tests"}
{"action":"update","baseRevision":1,"updates":[{"id":"<UUID from list>","status":"completed"}]}
{"action":"remove","baseRevision":2,"id":"<UUID from list>"}
{"action":"clear","baseRevision":3}
```

List before editing. List returns the full snapshot. Mutations return compact model-visible revision/change-count summaries (a changed ID when exactly one item changed), with independent, immutable full snapshots in `details` and `structuredContent`. Every mutation requires the current nonnegative `baseRevision`; conflicts require listing and retrying, never blind replay. Updates accept an atomic array of patches to make simultaneous graph changes. An empty description clears it; an empty dependencies array removes prerequisites. Status is `pending`, `in_progress`, or `completed`. Progressing/completing requires completed prerequisites. Reopening or deleting prerequisites rejects invalid descendants rather than cascading. No-op edits do not increment revision.

Limits: 40 tasks, 160 Unicode characters per nonblank title, 512 per description, 16 distinct dependency UUIDs per task, and 64 KiB of serialized UTF-8 state. Missing/self/cyclic dependencies reject the whole mutation. UUID task IDs are opaque and are not reset by clear.

## Human view

`/todo` opens a 100%-terminal overlay only in TUI mode. Arrows, PgUp/PgDn, Home/End select by stable ID; Enter inspects descriptions and dependencies; the same navigation keys scroll long details. `a` adds, `e` edits, `s` changes status or reopens. `d` then **distinct `y`** removes; `D` then `y` clears. Any other confirmation key cancels. Escape backs out or closes, Ctrl+C cancels. Input dialogs are cancellable, revision/branch-owned, and never replace or overwrite the main editor draft. Opening the view starts no model turn.

Task values are rendered inertly: native edit prefills and incoming text/pastes have terminal instructions and bidi controls removed before insertion, preserving native cursor/Undo semantics. Single-line prefills establish the native Undo baseline without an undoable insertion or remappable positioning keys. Unchanged edits preserve original task data rather than silently rewriting it. Tool/model JSON makes bidi controls visible as JSON escapes while `details`, `structuredContent` and persisted snapshots retain the original data. Partial-paste/escape timers are disposed with the owned form.

Character commands also accept Kitty CSI-u input, preserving case and modifiers; pasted text never invokes them. In Description, the configured `tui.input.submit` advances to Dependencies without clearing text or Undo. Configured `tui.input.newLine` takes precedence and remains native multiline editing.

Ordinary owned overlays preserve the main draft and insertion position. Native session replacement remains host-owned: Pi 1.0.4 resets the cursor to the end on new/reload, and native fork prefills the selected user message. Todo does not patch private cursor state or overwrite the host's intended fork draft to conceal those native behaviors.

RPC, print, and JSON tools work without custom terminal UI. `/todo` outside TUI gives a tool usage hint and does not mutate. It owns only the `pi-todo` compact status key, not the footer, editor, or other extension status keys. It never changes active tools or bypasses Plan-mode tool policy; manual edits are explicit user-owned command operations.

## Persistence and recovery

State is schema version 1: `{schemaVersion, revision, tasks}`, stored as `pi-todo:state` custom entries through public `pi.appendEntry`. For a file-backed session, **send an ordinary message first**. Before mutation, Todo requires an existing readable file with the matching public session header and an exact persisted user/assistant conversation record. A fresh pre-conversation manual edit is rejected before any append; Todo never manufactures a conversation or silently opts into volatile storage.

Explicit `--no-session` / SDK in-memory sessions support volatile edits. Their status and model context/results say **in-memory, not persistent after process exit**. There is no restart persistence in this mode.

For file-backed edits, every native root-to-leaf ancestor must be verified on disk **before** append, including messages and other non-Todo entries. Success then requires the exact newly appended custom entry (ID, data and native metadata) in a complete committed JSONL line. Verification is read-only and uses bounded chunks/lines, caching only unchanged file identities. Bounded records are compared after JSON parsing; oversized records require native canonical JSON (with LF or CRLF), not arbitrary JSON whitespace. It is evidence of a readable complete native record, **not** an fsync, atomic transaction, or crash-durability guarantee. Pi may mutate its native in-memory branch before a failed filesystem write; Todo does not patch/roll back that manager, rewrite its JSONL, or claim the native branch stayed unchanged. A positively verified complete write can be reported committed even if Pi subsequently throws. Otherwise the previous cache is retained, and an unverifiable/uncertain outcome is quarantined: edits and authoritative context are unavailable until storage is repaired and explicitly reconciled/reloaded. Any uncommitted native ancestor requires a native session reopen before further edits.

Recovery follows only public `getBranch()`, adopting the latest valid snapshot whose exact record is on disk, including explicit empty snapshots. Failed-write in-memory ghosts, altered same-ID data, incomplete lines, tool-result history and abandoned branches confer no authority. Malformed committed state entries warn and are ignored.

If native `getBranch()` stops at a missing parent after a failed write and later persisted tool result, Todo stays unavailable rather than treating that disconnected branch as a fresh checklist. Use explicit native tree navigation to a verified ancestor or native storage recovery, then reconcile; Todo never selects an unrelated branch or repairs native persistence itself.

Session start, reload/fork replacement, tree navigation, and compaction reconcile state and retire old UI. Awaited steps check manager/session ownership, the **full native entry data** in the prior branch prefix, and authoritative own-entry data; ordinary appends are allowed. Provider context receives the current full bounded snapshot once when no exact successful full current result supplies it, including after compact mutation results, compaction and nested calls. Unavailable state is identified without supplying a falsely authoritative snapshot. Context is never persisted and never wakes the model.

Implementation is original; no extension implementation is copied from Pi's example. Each package is independent.

## Development

`bun run check` in this package runs lint, typecheck, and Vitest, including real public SDK tool pipelines and terminal renderer fixtures. No external provider calls are required.

`python3 test/prefill-cli.py /tmp/todo-prefill-evidence` additionally runs the real Pi 1.0.4 offline CLI in regular and fullscreen PTYs with isolated remapped keybindings and bounded child lifetimes.
