# @signalridge/pi-subagents-protocol

Pure, side-effect-free wire contracts for the managed subagent protocol used by
`@signalridge/pi-subagents` and `@signalridge/pi-workflows`.

This package is a normal npm dependency, not a Pi extension. It does not register
listeners, read settings, own lifecycle state, or start timers. The runtime owner
remains `pi-subagents`; workflow state and journal ownership remain in
`pi-workflows`.

The protocol-v4 contract validates managed spawn requests, exact workflow owners, bounded terminal snapshots, owned quiescence responses, capabilities, and RPC envelopes.

A managed request names an Agent `tier` — a key in the host's own tier catalogue, not a separate workflow vocabulary — and carries no per-call model or thinking: a tier is the only model policy a caller can express, so there is no second selector that could silently win or be silently ignored. Optional hints can carry a named toolset, tool denylist, thread name, or worktree intent; `pi-subagents` remains the final resolver and enforces model scope, tool policy, concurrency, retries, skills, cwd, and isolation.

Every v4 capability is required — there is no partial peer to negotiate with — and every ping carries the host's Agent-tier catalogue plus a canonical SHA-256 fingerprint. `agentTierPolicyIdentity()` narrows that catalogue to the part that decides how one named tier resolves, so a caller's replay cache can key each call on its own tier: defining or editing an unrelated tier then invalidates nothing.

Because `parseProtocolPing` rejects unknown keys, the ping envelope cannot grow by a peer simply volunteering a field — that would make every already-published caller refuse the handshake. It grows the other way instead: a caller lists the extra fields it can parse in the request's `include` array (read with `parsePingIncludes`, which bounds it to 8 names), and the peer answers with only those. `maxConcurrent`, the peer's live background-agent pool size, is the first such field. Both directions stay compatible without a version bump, and an absent field means "this peer does not publish it", not a malformed reply.
