# @signalridge/pi-subagents-protocol

Pure, side-effect-free wire contracts for the managed subagent protocol used by
`@signalridge/pi-subagents` and `@signalridge/pi-workflows`.

This package is a normal npm dependency, not a Pi extension. It does not register
listeners, read settings, own lifecycle state, or start timers. The runtime owner
remains `pi-subagents`; workflow state and journal ownership remain in
`pi-workflows`.

The v3 contract validates managed spawn requests, exact workflow owners, bounded terminal snapshots, owned quiescence responses, capability negotiation, and RPC envelopes. Optional managed policy hints can carry an exact model/thinking selector, named toolset, tool denylist, thread name, or worktree intent; `pi-subagents` remains the final resolver and enforces model scope, tool policy, concurrency, retries, skills, cwd, and isolation.
