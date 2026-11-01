# pi-code-actions

/code to pick code blocks (```) or `inline code` from recent assistant messages and then copy or insert them. Helpful for retrieving commands and filepaths mentioned by Pi.

/code opens a menu you can type to search. You can hit enter to copy the snippet, or `right arrow` to insert it in the command line.

<img width="751" height="416" alt="Screenshot 2026-01-09 at 17 09 17" src="https://github.com/user-attachments/assets/0dc10a64-d61f-4b56-9684-5e448c759385" />


## Install

```bash
pi install npm:@signalridge/pi-code-actions
```

```bash
pi install npm:@signalridge/pi-code-actions
```

Then filter to just this extension in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "npm:@signalridge/pi-code-actions",
      "extensions": ["index.ts"]
    }
  ]
}
```

## Usage

- Command: `/code`
- Optional args:
  - `all` to scan all assistant messages in the current branch (default: all)
  - `blocks` to hide inline snippets (default: inline + fenced blocks)
  - `limit=50` to cap the number of snippets returned (default: 200)
  - `copy`, `insert`, or `run` to choose an action up front
  - a number to pick a specific snippet (1-based)

Examples:
- `/code`
- `/code blocks`
- `/code copy`
- `/code all`
- `/code limit=50`
- `/code run 2`

## Actions

- Copy (TUI only): puts the snippet on your clipboard through Pi's own clipboard writer, the same one Pi's built-in copy uses. It covers the native clipboard, `pbcopy`, `wl-copy`/`xclip`/`xsel` (which keep owning the Linux selection after the copy), Termux, and WSL, and emits OSC 52 for remote sessions (SSH, mosh, or `PI_CLIPBOARD_OSC52=1`) so the copy reaches the client terminal. A failure reports Pi's reason, such as which clipboard utility to install
  RPC copy explicitly reports unavailable: terminal clipboard escape sequences cannot reach the client through the server's clipboard writer. RPC supports indexed Insert and Run instead.
- Insert: appends the snippet to the TUI input editor. RPC cannot read or append to the client draft, so insertion requires confirmation before replacing the entire draft
- Run: executes the complete snippet with `bash -lc` on POSIX or `powershell -NoProfile -Command` on Windows (asks for confirmation), in the working directory captured before confirmation. Output and the shell's exit code are displayed after cleanup.

`/code run` is a user-confirmed full-shell action, not an agent tool call. Tool-call permission rules and plan-mode tool restrictions do not intercept it. Confirmation is not a sandbox: review the entire snippet, and use copy/insert instead when execution is forbidden by your policy.

## Notes

- Pending dialogs and running snippets are cancelled on pre-switch, pre-fork, pre-tree, session start, committed tree, and shutdown events. A pending copy stops being awaited at the same events and its outcome is not reported; Pi's clipboard utilities are not cancellable and are bounded by Pi's own timeout. A pre-navigation event cancels the interaction even if navigation is later vetoed; this does not provide an atomic post-veto transition.
- At pre-navigation boundaries, custom TUI panes close synchronously, restoring their captured draft before navigation can write a new one.
- Snippet subprocesses are owned locally, not delegated to a background extension. On POSIX, a detached supervisor holds a private process group alive through a 250 ms TERM grace period, then KILLs the group; this also cleans up background children after normal shell exit. Signals never target Pi's/ancestor shells' group or a previously reaped leader. Cleanup waits are bounded (up to two 1-second waits for exit/output closure). On Windows, the live supervisor anchors `taskkill /PID /T /F`, with a 1-second taskkill deadline and direct-parent fallback; this is best-effort tree cleanup, not a Windows Job Object guarantee.
- When Pi runs under Bun (including compiled standalone builds), snippet supervision requires a Node.js executable named `node` on `PATH`; a missing executable reports a failed run. Node-hosted Pi reuses its Node executable. The supervisor must signal readiness within 5 seconds; stalled startup (for example, inherited `NODE_OPTIONS=--inspect-brk=0`) or disconnected IPC fails the run and triggers owned cleanup. This startup deadline does not limit snippet execution after readiness. Runtime/security options and the snippet environment are inherited unchanged.
- This is lifecycle cleanup, not containment: processes that deliberately create a new session/group, detached Windows processes, an externally killed supervisor, or abrupt termination of Pi can evade cleanup. Keep long-lived services outside `/code run`.
- Snippet output captures the first 64 KiB of stdout and stderr independently (128 KiB combined, plus small per-stream loss notices). Both pipes continue draining after overflow, without retaining further data. UTF-8 is decoded independently per stream, and a character cut at the capture boundary is dropped rather than replaced. Decoded output is also byte-bounded, including invalid UTF-8 replacement expansion. Only an overflowing stream gets a truncation notice; discarded output is not saved elsewhere. Ordinary output and exit codes are unchanged.
- Only assistant messages are scanned.
- Inline code uses single backticks. Code blocks use triple backticks.
- Inline snippets are filtered to path-like content: `~/...`, `./...`, paths with 2+ slashes, or files with extensions. Use `blocks` to show only code blocks.

## Changelog

See `CHANGELOG.md`.
