---
"@signalridge/pi-subagents": patch
---

Enforce child `ext:` tool narrowing and `ask_tools:` consent through Pi's public `tool_call` event, including nested codemode/MCP `ctx.executeTool()` calls that bypassed the model-only hook. The policy runs before other extensions can mutate the call event and checks the effective registered tool source, so same-name tools from unselected extensions cannot borrow a selected tool's permission. Pi 0.99 children now load the SDK's public codemode, tool-search, and MCP built-in factories subject to `extensions:`, `exclude_extensions:`, and `ext:` selectors; older hosts remain supported.
