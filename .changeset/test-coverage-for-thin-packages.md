---
"@signalridge/pi-input-history": patch
"@signalridge/pi-input-prefix": patch
"@signalridge/pi-gpt-fast": patch
"@signalridge/pi-ralph-wiggum": patch
---

Real test coverage for the four packages that had almost none. No behaviour changes; the only source edit is that `pi-input-history` now exports the pure helpers its tests drive.

- **pi-input-history** (606 lines of source, previously a 21-line registration smoke test): 34 tests over the logic that decides which prompts the Ctrl+R popup shows and in what order — the fuzzy matcher's ordering and token rules, the cross-session merge and its dedup precedence, timestamp parsing, and the age labels.
- **pi-gpt-fast** (previously an 18-line registration smoke test): 19 tests over the one decision the extension makes — whether a request carries `service_tier: "priority"`. Covers the exact-pair allowlist (a lookalike provider on the same model id must not match), payload preservation, non-object payloads, toggle and argument handling, settings persistence including the read-modify-write that protects pi's own keys, and the `fast` vs `fast (armed)` distinction.
- **pi-input-prefix** (previously a linear assertion script with no named tests): the same assertions, now 31 named `node:test` cases plus new coverage for label insetting, one-column rules, slash-token boundaries, and shell-bang detachment edge cases. A failure now names the case instead of aborting the file at the first bad assertion.
- **pi-ralph-wiggum** (previously one linear script in a `try`/`finally`): 18 named cases covering loop ownership across sessions, what a former owner may no longer do after ownership transfers, loop lifecycle transitions, and legacy state migration.
