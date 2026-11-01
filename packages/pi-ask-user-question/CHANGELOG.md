# Changelog

## 1.3.6
### Patch Changes

- da9ed0f: Develop and test against Pi 1.4.0. The package's SDK and rendering tests now run on the new baseline host, including the 1.2 run-start and 1.3 dialog-stack changes; no runtime behavior changed.

## 1.3.5
### Patch Changes

- c2fd867: Keep Other answers and option payloads separate from sanitized display copies while respecting native editor submit transformations. Reject oversized responses explicitly, and settle host-completion and overflow-notification failures as structured UI errors while retaining collected answers and distinguishing cancellation/abort.

## 1.3.4
### Patch Changes

- 3364cc0: Use patched Vitest 4.1.11 for development and regression testing without moving to a new major version. Refresh compatible transitive dependencies to include fixed source-map and brace-expansion releases.
- 3364cc0: Adopt Pi 1.0.4's host-provided dependency contract: declare imported Pi and TypeBox modules as `*` peers rather than installing duplicate runtime modules, and align Pi development pins with the repository's tested 1.0.4 baseline. The wildcard identifies host module ownership; it does not promise compatibility with every Pi version.
- 3364cc0: Allow independent paging through long question text and option descriptions in short terminals. Return to the selected control before accepting an answer while reading, without losing height-bounded controls or editor focus.
- 3364cc0: Preserve native descendant keyboard focus and custom overlay widths. Keep question frames and active controls within the terminal viewport, and distinguish RPC actions from duplicate or reserved option labels. Bound file-browser rows and dispose browser work and polling when interactions close or the session shuts down, without clearing badges on a vetoed session switch.

## 1.3.3
### Patch Changes

- 8190516: Extend the tested Pi host compatibility range through 0.87.x while retaining supported older hosts. Validate the published extensions against Pi 0.87.1 and adapt changed provider, session-context, and lifecycle contracts where necessary.
- 8190516: Add Pi 0.99.1 to the supported host peer ranges while retaining Pi 0.84–0.87 compatibility. Align Pi development dependency pins with 0.99.1 for validation against the new host.

## 1.3.2
### Patch Changes

- 1f586f8: Expand Pi peer support to `^0.84.0 || ^0.85.0`, retaining 0.84 compatibility while admitting 0.85 releases. The previous zero-major caret range excluded Pi 0.85.1. Update existing Pi development dependency pins to 0.85.1.
- 1f586f8: Cancel RPC question dialogs at the host, serialize LSP fixes with native file edits when the host provides a mutation queue, resolve workspace paths against session context, track successful shell commits, and report terminal-only commands explicitly over RPC.

## 1.3.1
### Patch Changes

- 28c8aa1: Remove non-functional references to external product names from package descriptions, examples, and comments. Provider identifiers required for runtime compatibility remain unchanged.

## 1.3.0
### Minor Changes

- 07350d4: Add the Claude/Kimi-style `ask_user_question` tool with structured answers, a bordered TUI dialog, and RPC fallback prompts.

## 1.2.0

- Add the `ask_user_question` LLM-callable tool with bordered TUI and RPC selection flows.
