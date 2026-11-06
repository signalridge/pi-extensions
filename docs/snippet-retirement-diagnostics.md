# Snippet retirement diagnostic evidence (#64)

This repository-only harness measures, rather than presumes, the cause of a
historical descendant-liveness assertion failure. It changes no published runtime
or package test. Its successful check means **the harness completed and the
candidate passed**, not that #64 can close.

## Immutable comparison

- Original failing source: `c00f9f990f201340b27658dcb525ddcdb14c08ec`,
  [run 39971697137, attempt 1](https://github.com/signalridge/pi-extensions/actions/runs/39971697137/attempts/1),
  job `120475762499`.
- The same source also passed in
  [run 39971697420, attempt 1](https://github.com/signalridge/pi-extensions/actions/runs/39971697420/attempts/1).
- A second historical failure is source
  `0f66042484cbc4cc61851e9b4d2f182ef11f0d0d`,
  [run 39975979776](https://github.com/signalridge/pi-extensions/actions/runs/39975979776),
  job `120490554411`. It is provenance, not another independently tuned arm.

The exact selected case is
`session_before_tree waits for real TERM-resistant children and suppresses stale output`.
Both original immediate assertions, their messages, and candidate assertions are
preserved. #85's independent owned-promise gate is exercised by normal Code
Actions tests, not substituted for historical OS-process evidence.

The candidate checkout is the immutable PR **head SHA** (`github.event.pull_request.head.sha`),
not GitHub's synthetic PR merge preview. Manual runs use `github.sha`, the immutable
commit selected for that dispatch. `candidate-source.json` records the actual
checked-out revision and content hashes; the workflow expression uses only trusted
GitHub context, never an interpolated user ref.

## Primary run

Use **Snippet retirement diagnostics**, manually or on a same-repository PR. One
native x64 `ubuntu-24.04` job installs Node **24.21.0** and Bun **1.3.14** once,
then installs each source's own frozen lockfile separately with scripts disabled.
It runs 200 **pairs** by default (bounded configurable 1–1000), alternating
baseline/candidate then candidate/baseline, sequentially on that same VM. There
is no matrix, scheduler manipulation, synthetic delay, or load generator.

Linux **Python 3.9+** with standard-library `os.pidfd_open` and
`signal.pidfd_send_signal`, a supporting kernel, and readable `/proc` identities
is an explicit prerequisite (Python 3 is preinstalled on Ubuntu 24.04). A
self-only signal-0 capability probe runs before fixtures exist. Unsupported,
unreadable or unknown capability fails closed: there is no numeric-PID rescue
fallback. No Python packages or global dependencies are installed. `pidfd.json`
records the capability result, exact Python version/path, Python executable
SHA-256 and helper SHA-256; `host.json` also records the helper hash.

The OS label is **not** proof of the historical immutable runner image. Artifact
`host.json` records ImageOS/ImageVersion, kernel/uname, architecture, CPU models,
UID, PID namespace, PID 1 identity, executable SHA-256s, exact toolchain, limits,
and instrumentation hashes. Each arm records its revision, lock hash, every
package source hash and transformed test/runtime hashes. Do not equate a newer
runner image with the historical one.

To run on prepared Linux checkouts (separate frozen installs required):

```sh
node candidate/scripts/snippet-retirement-diagnostics.mjs baseline candidate evidence 200 primary
```

`primary` checks x64, Node version, and GitHub ImageOS. `secondary` explicitly
labels container or other Linux experiments and **cannot** satisfy the primary
closure requirement. Containers change PID namespace/reaping behavior; record
that fact. Do not add host-PID, privileged, or an init process silently.

## Observer and cleanup contract

Private temporary package copies are transformed using verified unique anchors.
Both arms use the same observer. Missing/duplicate anchors fail closed. No
production checkout is edited. Source assertions and these limits are unchanged:
startup 5000 ms, TERM grace 250 ms, supervisor exit/close wait 1000 ms each,
test 10000 ms, retirement assertion 3000 ms, descendant observation 4000 ms.
Candidate's existing descendant observation and diagnostic cleanup share the
four-second post-retirement observation budget, not two consecutive allowances.

The original `alive()` performs its original kill-0/raw-stat/zombie predicate
**before** observer enrichment or disk writes. Its boolean, raw stat or errno,
wall time and monotonic evaluation interval are buffered (with clock origin, so
per-process monotonic domains are explicit). This matters because
recording only a later PID snapshot could erase the race being investigated.
Observation itself still perturbs scheduling; a non-reproduction is inconclusive.
Retirement wrappers return the same promises, recording call and completion.
Parent-side hooks record the actual detached supervisor PID and observed exit,
close, and group TERM/KILL call/return (not claims of kernel signal delivery).

Before any extra fixture-rescue SIGKILL, all known fixture identities and raw
`/proc` stat/status signal-pending fields are persisted. Natural disappearance is
observed for up to the existing four-second budget **without extra signals**.
Only then is an explicit rescue-start persisted if rescue is needed. Individual
fixture PIDs, never arbitrary groups, are rescued only through the one-shot Python
pidfd helper. After durable rescue intent, the helper **first acquires a pidfd**,
then reads and validates the expected PID/starttime, same UID (all four `/proc`
UID fields), PGID and SID, refusing self and the unrelated sentinel, zombies,
unreadable/unknown identities and pre-acquisition PID replacements. Only then does
it send SIGKILL **through that held descriptor**, closing it in `finally` even on
refusal or send failure. A replacement after validation cannot retarget the held
pidfd: the old task is signalled or the kernel returns ESRCH, never the new numeric
PID. No `kill(pid, SIGKILL)` fallback exists in either normal or watchdog rescue.
EPERM/unknown is not absence; a refused/failed/unknown rescue leaves cleanup
unconfirmed and stops subsequent rounds, even if a later snapshot looks quiet.
Zombies are distinct from live survivors. Direct supervisor handles must close;
orphan zombies are reported, never falsely claimed reaped by this harness.

A separately owned sentinel in the orchestrator's unrelated process group is
identity-checked after every round and reaped using stdin EOF, without a signal.
A missing/reused/dead sentinel fails the harness.

Each failed round still cleans its own workers. Unconfirmed cleanup aborts all
subsequent rounds; a bounded emergency path first persists/observes identities,
then uses the same pidfd-only dispatch for its own worker rescue. Its final record
also requires observed worker `close` (not just an exit code). The outer 14-second watchdog is a
harness-safety deadline, not a widened assertion or production timeout. Rescue
or a candidate/setup failure fails the harness. Original assertion failures are
expected evidence and do not prevent candidate rounds from running.

Artifacts contain only narrow PID metadata, selected assertion identifiers,
results, timelines and hashes: no environment dump, credentials, snippet source,
user code, or raw reporter output. Workflow permissions are contents-read only,
checkout credentials are not persisted, and artifact upload runs even on failure.
No workflow closes issues or invokes providers.

Portable unit tests run the helper with a fake kernel backend and exercise both
normal/watchdog dispatches, including replacements before pidfd acquisition and
between final validation and send, ESRCH, permission/read failures, refusal and
fd closure. They never signal user processes. An explicit Linux-only
`python3 -B scripts/fixtures/snippet-retirement-pidfd.test.py --kernel-probe`
secondary probe may separately verify actual kernel APIs on a private owned child;
it is not historical-race or primary closure evidence.

## Adjudication (separate from harness success)

Read `summary.json` and each round's JSONL **before** rescue-start. A baseline
failure that disappears naturally before rescue is different from a survivor
requiring forced rescue. Compare raw predicate results with retirement returns,
group signals, supervisor exit/close, first zombie/absence observation, pending
signals, and starttime identity. Do not infer descendant disappearance from
supervisor exit alone, or infer signal delivery merely from kill() success.

A baseline that never reproduces MUST report
**INCONCLUSIVE: baseline failure not reproduced**. A passing candidate or ordinary
PR CI cannot turn that into a root-cause claim. A secondary reproduction also
cannot replace native primary evidence. Even a primary reproduction requires
human adjudication; `closureAuthorized` is always false.

Before #64 closes, retain a native primary baseline pre-rescue failure and its
natural-versus-forced timeline, establish the actual cause from those records,
verify the candidate's assertions and ordinary PR CI, and perform any required
normal release. If evidence instead shows a real survivor bug, investigate it
before changing runtime architecture. This harness is diagnostic, not a
permanent flaky required-baseline-reproduction check.
