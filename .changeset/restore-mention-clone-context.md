---
"@signalridge/pi-subagents": patch
---

Keep model-assisted agent mentions on Pi 0.84–0.99 without silently exposing the parent's raw, pre-hook conversation to the hidden provider turn. The throwaway session now sees only the current mention text, a static narrow system prompt, and its single Agent tool; it receives no parent history, system prompt, other tools, or summaries. Pi's public extension context cannot replay programmatic parent privacy hooks, so partial hook copying is not a safe fix. Pin the Agent call to the mentioned type and report success only after background spawn acknowledgement. Fence asynchronous dispatch to its originating session; a policy refusal cannot be retried through direct spawning, and a direct infrastructure fallback revalidates that the selected agent type remains enabled. Explicit child `inherit_context: true` is refused under the current host APIs rather than forwarding unredacted parent history; pass a reviewed, sanitized task summary instead.
