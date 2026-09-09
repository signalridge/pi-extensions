# Changelog

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
