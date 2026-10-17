"""Real Pi CLI/PT Y acceptance; standard-library only, no installs or live providers.
Run: python3 packages/pi-background/test/shortcut-cli.py
Frames come from public Component.render instrumentation, not a simulated editor.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
FIXTURE = Path(__file__).with_name("shortcut-cli-fixture.ts")
TASKS = b"\x1b[98;7u"  # Kitty Ctrl+Alt+B, exercised through the real terminal parser.
DRAFT = b"\x1b[100;7u"
ESC = b"\x1b"
checks = 0


def check(value, description):
    global checks
    assert value, description
    checks += 1


class CLIHost:
    def __init__(self, mode, width, height):
        self.temp = tempfile.TemporaryDirectory(prefix="background-shortcut-")
        self.path = Path(self.temp.name)
        self.probe = self.path / "probe.jsonl"
        self.raw = bytearray()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(self.path)
            env = {**os.environ, "PI_CODING_AGENT_DIR": str(self.path / "agent"),
                   "PI_CODING_AGENT_SESSION_DIR": str(self.path / "sessions"),
                   "BACKGROUND_SHORTCUT_PROBE": str(self.probe), "TERM": "xterm-256color",
                   "PI_OFFLINE": "1", "PI_TELEMETRY": "0"}
            os.execvpe("node", ["node", str(CLI), "--offline", "--no-session", "-ne", "-ns", "-np",
                              "--no-themes", "-nc", "--no-mcp", "-e", str(FIXTURE),
                              "--model", "background-shortcut-faux/acceptance", "--tui-mode", mode], env)
        self.resize(width, height)
        self.wait(lambda: any(e["event"] == "ready" for e in self.events()))
        self.pump(0.2)

    def resize(self, width, height):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)

    def events(self):
        if not self.probe.exists():
            return []
        return [json.loads(line) for line in self.probe.read_text().splitlines() if line.endswith("}")]

    def of(self, name):
        return [e for e in self.events() if e["event"] == name]

    def pump(self, duration=0.08):
        end = time.monotonic() + duration
        while time.monotonic() < end:
            ready, _, _ = select.select([self.fd], [], [], max(0, end - time.monotonic()))
            if ready:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                self.raw.extend(data)
                if b"\x1b[?u" in data:
                    os.write(self.fd, b"\x1b[?1u")
                if b"\x1b[6n" in data:
                    os.write(self.fd, b"\x1b[1;1R")

    def wait(self, condition, timeout=12):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pump()
            if condition():
                return
        raise AssertionError(f"Timed out; events={self.events()[-5:]}; raw={bytes(self.raw[-2500:])!r}")

    def key(self, data):
        os.write(self.fd, data)
        self.pump()

    def paste(self, text):
        self.key(b"\x1b[200~" + text.encode() + b"\x1b[201~")

    def command(self, text):
        self.key(b"\x05")  # End first: Ctrl+U alone leaves the suffix at a mid-line cursor.
        self.key(b"\x15")
        self.paste(text)
        self.key(b"\r")

    def text(self):
        frames = self.of("frame")
        return "\n".join(frames[-1]["lines"]) if frames else ""

    def close(self):
        try:
            self.key(b"\x03")
            self.key(b"\x03")
            self.key(b"\x04")
        except OSError:
            pass  # Host may exit before the final key.
        for attempt in range(30):
            self.pump(0.1)
            if os.waitpid(self.pid, os.WNOHANG)[0]:
                break
            if attempt == 15:
                os.kill(self.pid, signal.SIGTERM)
        else:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        os.close(self.fd)
        self.temp.cleanup()


for mode in ["fullscreen", "regular"]:
    for width, height in [(100, 30), (40, 12)]:
        host = CLIHost(mode, width, height)
        try:
            # Empty entry: no model turn, preserve draft and the mid-CJK cursor.
            host.paste("ab中日cd")
            host.key(b"\x1b[D")
            host.key(b"\x1b[D")
            host.key(TASKS)
            host.wait(lambda: "No background jobs" in host.text())
            check(host.of("open")[-1]["draft"] == "ab中日cd", "empty entry preserves draft")
            host.key(TASKS)
            check(len(host.of("open")) == 1, "repeat does not reopen empty view")
            frame = host.of("frame")[-1]
            check(frame["width"] == width and len(frame["lines"]) <= height, "native dimensions")
            host.key(ESC)
            host.wait(lambda: len(host.of("close")) == 1)
            host.paste("X")
            host.key(DRAFT)
            check(host.of("draft")[-1]["draft"] == "ab中日Xcd", "CJK draft/cursor restored by host")
            check(not host.of("agent-start"), "entry alone never starts a model turn")

            # Native dialog and extension overlay keep input ownership.
            host.command("/probe-other")
            host.wait(lambda: bool(host.of("other-open")))
            host.key(TASKS)
            check(len(host.of("open")) == 1, "does not steal another native dialog")
            host.key(ESC)
            host.wait(lambda: bool(host.of("other-close")))
            host.command("/probe-overlay")
            host.wait(lambda: bool(host.of("overlay-open")))
            host.key(TASKS)
            check(len(host.of("open")) == 1, "does not stack over another overlay")
            check(host.of("overlay-key")[-1]["data"] == TASKS.decode(), "foreign overlay receives shortcut bytes")
            host.key(ESC)
            host.wait(lambda: bool(host.of("overlay-close")))

            # Real tool pipeline starts owned jobs; shortcut selects without submitting draft.
            host.command("Start independent background work")
            host.wait(lambda: bool(host.of("settled")))
            host.paste("unfinished 中 draft")
            host.key(TASKS)
            host.wait(lambda: "Background tasks" in host.text() and "2 retained" in host.text())
            host.key(b"\r")
            host.wait(lambda: "first-log" in [row.strip() for row in host.text().splitlines()])
            check("first-log" in [row.strip() for row in host.text().splitlines()], "first real output row")
            host.key(ESC)
            host.key(b"\x1b[B")
            selected = next(row for row in host.text().splitlines() if row.startswith("ID:"))
            opens = len(host.of("open"))
            turns = len(host.of("agent-start"))
            host.key(TASKS)
            check(len(host.of("open")) == opens, "repeat does not replace task selector")
            check(selected in host.text(), "repeat preserves stable task selection")
            host.key(b"\r")
            host.wait(lambda: "second-log" in [row.strip() for row in host.text().splitlines()])
            check("second-log" in [row.strip() for row in host.text().splitlines()], "second real output row")
            host.key(TASKS)
            check("Background logs" in host.text() and len(host.of("open")) == opens, "repeat preserves logs mode")
            host.key(b"x")
            host.key(ESC)
            check("Status: running" in host.text(), "escape cancels stop confirmation")
            host.key(b"x")
            host.key(b"y")
            host.wait(lambda: "Status: stopped" in host.text())
            check(len(host.of("agent-start")) == turns, "navigation/stop cause no model turn")
            host.key(ESC)
            host.key(ESC)
            host.wait(lambda: len(host.of("close")) == opens)
            check(host.of("close")[-1]["draft"] == "unfinished 中 draft", "running-job viewer restores draft")
            check(b"Ctrl+Alt+B tasks" in host.raw, "native status displays keyboard entry hint")

            # Public command context commits navigation while shortcut viewer is mounted.
            host.command("/probe-retire")
            host.wait(lambda: bool(host.of("retire-armed")))
            host.key(TASKS)
            host.wait(lambda: len(host.of("open")) == opens + 1)
            host.wait(lambda: bool(host.of("retired")))
            check(host.of("retired")[-1]["cancelled"] is False, "navigation committed")
            check(len(host.of("close")) == opens + 1, "retirement closes shortcut-owned viewer")
            host.key(TASKS)
            host.wait(lambda: "No background jobs" in host.text())
            check(len(host.of("open")) == opens + 2, "new session has fresh empty selector")
            host.key(ESC)
            print(f"PASS {mode} {width}x{height}")
        finally:
            host.close()
print(f"PASS {checks} real CLI shortcut checks")
