"""Real Pi 1.0.4 offline CLI/PTY regression, stdlib only.
Run: python3 packages/pi-todo/test/prefill-cli.py /tmp/todo-prefill-evidence
Each child has isolated configuration, a 25s deadline, and guaranteed kill/reap.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
FIXTURE = Path(__file__).with_name("prefill-cli-fixture.ts")
OUT = Path(sys.argv[1]).resolve()
OUT.mkdir(parents=True, exist_ok=True)


def run(mode):
    with tempfile.TemporaryDirectory(prefix="todo-prefill-cli-") as temporary:
        agent = Path(temporary) / "agent"
        agent.mkdir()
        (agent / "settings.json").write_text(json.dumps({"quietStartup": True}))
        bindings = {"tui.editor.cursorLineEnd": "ctrl+e", "tui.editor.deleteCharForward": "end"}
        (agent / "keybindings.json").write_text(json.dumps(bindings))
        evidence = OUT / f"cli-{mode}.jsonl"
        evidence.write_text("")
        raw = bytearray()
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(temporary)
                env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1",
                       "PI_TELEMETRY": "0", "TERM": "xterm-256color",
                       "PI_TODO_CLI_EVIDENCE": str(evidence)}
                os.execvpe("node", ["node", str(CLI), "--offline", "--no-session", "-ne", "-ns", "-np",
                                  "--no-themes", "-nc", "--no-mcp", "-e", str(FIXTURE),
                                  "--model", "todo-prefill-faux/acceptance", "--tui-mode", mode], env)
            finally:
                os._exit(127)
        deadline = time.monotonic() + 25
        reaped = False

        def events():
            return [json.loads(line) for line in evidence.read_text().splitlines() if line.endswith("}")]

        def pump(duration=0.08):
            end = min(deadline, time.monotonic() + duration)
            while time.monotonic() < end:
                ready, _, _ = select.select([fd], [], [], max(0, end - time.monotonic()))
                if ready:
                    try:
                        data = os.read(fd, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    raw.extend(data)
                    del raw[:-65536]
                    if b"\x1b[?u" in data:
                        os.write(fd, b"\x1b[?1u")
                    if b"\x1b[6n" in data:
                        os.write(fd, b"\x1b[1;1R")

        def wait(predicate):
            while time.monotonic() < deadline:
                pump()
                if predicate():
                    return
            raise AssertionError(f"CLI {mode} deadline: {bytes(raw[-2000:])!r}; {events()}")

        def key(data):
            os.write(fd, data)
            pump()

        def command(text):
            key(b"\x1b[200~" + text.encode() + b"\x1b[201~")
            key(b"\r")

        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            wait(lambda: any(event["event"] == "ready" for event in events()))
            pump(0.3)
            command("/todo")
            wait(lambda: b"Session Todo" in raw)
            key(b"\x1b[F")
            key(b"e")
            wait(lambda: b"Task title" in raw)
            key(b"\r")
            wait(lambda: b"Description (0-512" in raw)
            key(b"\r")
            wait(lambda: b"Dependency UUIDs" in raw)
            key(b"\r")
            pump(0.3)
            key(b"\x1b")
            pump(0.2)
            command("/todo-proof-result")
            wait(lambda: any(event["event"] == "result" for event in events()))
            records = events()
            initial = next(event["initial"] for event in records if event["event"] == "ready")
            result = next(event for event in records if event["event"] == "result")
            assert result["snapshot"] == initial, f"Unchanged edit mutated state: {records}"
            assert result["turns"] == 0, "CLI edit must not call a model"
            assert json.loads((agent / "keybindings.json").read_text()) == bindings
            while time.monotonic() < deadline:
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    reaped = True
                    assert os.waitstatus_to_exitcode(status) == 0, f"CLI exit {status}"
                    break
                pump()
            assert reaped, "CLI did not exit after public ctx.shutdown()"
            print(f"PASS {mode}: actual offline CLI unchanged CJK/dependencies/revision, zero model turns, exit 0")
        finally:
            if not reaped:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
            os.close(fd)
            (OUT / f"cli-{mode}.ansi").write_bytes(raw)


for tui_mode in ("regular", "fullscreen"):
    run(tui_mode)
