# Native SDK regression evidence

Tests run against installed Pi 1.0.4. The initial tests were executed against the copied, unmodified implementation before applying the fixes. Initial copied SDK tests passed (11); the RPC fixture first needed package-relative SDK CLI resolution in the isolated checkout.

The added regression subset initially reported 11 failures. Two harness assertions were corrected before rerunning the decisive cases: wait for the actual custom-backend turn to settle or request approval (not an immediately idle session), and admit either the original inline review or the new overlay before opening the foreign UI.

Observed BEFORE results:

- **Backend provenance:** Real `AgentSession.baseToolsOverride` supplied a native write factory whose custom operations reject. With no certification flag, the old extension replaced it; approving through the SDK pipeline produced local marker bytes `[108,111,99,97,108]` (`local`). The fixed test checks no marker, unchanged original schema identity, and zero original operation calls.
- **Service discovery:** Loaded extension returned no service before startup.
- **Append affinity:** Two held requests both emitted `resolved/retired` following public native rename and ordinary custom-entry append.
- **Veto:** Native `navigateTree()` returned `cancelled: true`, but the unchanged session's request resolved as retired.
- **Committed tree:** Successful native tree navigation followed by a write produced no approval request.
- **Opaque identity:** SDK tool pipeline using `call_123|fc_456` produced no approval request. Installed OpenAI Responses stream code constructs identity as `${item.call_id}|${item.id}`; native nested execution appends `/n`.
- **Admission:** An earlier session-start deactivation under an initial SDK allowlist was restored to `read,bash,edit,write` instead of remaining `read`.
- **Aliases:** Uncooperative `hypa_shell` command-shaped input executed once instead of being blocked.
- **Foreign UI:** Actual `InteractiveMode` custom/confirm hosts, with their native TUI stack and native completion callbacks unchanged, resolved the old review upon abort before the foreign interaction responded. Fixed tests defer review completion, keep the foreign focus/respondability, then leave no overlay and preserve the editor draft.
- **Bounds:** Original inline layout did not satisfy the bounded narrow-terminal viewport assertions.

AFTER checks retain these regressions plus native switch/fork vetoes, aborted tree-summary recovery, partial admission, API-v1 cooperative schema identity/duplicate/malformed/async capability checks, native overlay command approval while a tool waits, and controlled denial behind a later foreign overlay. RPC uses the actual CLI transport: wrong lifecycle ID cannot act as a confirmation nonce; completing one request leaves a second held request untouched.

Verification commands:

- `cd packages/pi-approval-core && bun run check` — lint, full source/test typecheck, tests.
- `cd packages/pi-approvals && bun run check` — lint, full source/test typecheck, SDK/TUI/RPC tests.
- `npm pack --dry-run --json --ignore-scripts` in both packages — expected independent published file lists; tests do not ship.

No dependency installation or root configuration change was made. The required root `bun run check` passed JSON validation, then stopped because the isolated root has no dependencies (`ERR_MODULE_NOT_FOUND: semver` in `scripts/check-package-config.mjs`). Root integration remains separate from these package checks.
