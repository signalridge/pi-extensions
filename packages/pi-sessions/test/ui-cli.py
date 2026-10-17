"""Real Pi 1.0.4 CLI/PTY UI acceptance, stdlib only; no live provider calls.
Run: python3 packages/pi-sessions/test/ui-cli.py /tmp/pi-sessions-ui-cli
Frames use public SDK post-composition APIs inside the actual CLI, not render()
instrumentation. Raw terminal output and JSONL frames remain in the output dir.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
FIXTURE = Path(__file__).with_name("ui-cli-fixture.ts")
OUT = Path(sys.argv[1]) if __name__ == "__main__" else Path(tempfile.gettempdir())
if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
checks = 0


def check(value, message):
    global checks
    assert value, message
    checks += 1


class Host:
    def __init__(self, mode):
        self.temp = None
        self.pid = self.fd = None
        self.closed = False
        self.ready = False
        self.raw = bytearray()
        self.mode = mode
        try:
            self.temp = tempfile.TemporaryDirectory(prefix="sessions-ui-cli-")
            self.probe = OUT / f"{mode}.jsonl"
            self.probe.write_text("")
            self.pid, self.fd = pty.fork()
            if self.pid == 0:
                try:
                    os.chdir(self.temp.name)
                    env = {**os.environ, "PI_CODING_AGENT_DIR": self.temp.name + "/agent",
                           "PI_CODING_AGENT_SESSION_DIR": self.temp.name + "/sessions",
                           "SESSIONS_UI_PROBE": str(self.probe), "TERM": "xterm-256color",
                           "PI_OFFLINE": "1", "PI_TELEMETRY": "0"}
                    os.execvpe("node", ["node", str(CLI), "--offline", "--no-session", "-ne", "-ns", "-np",
                                      "--no-themes", "-nc", "--no-mcp", "-e", str(FIXTURE),
                                      "--model", "sessions-ui-faux/acceptance", "--tui-mode", mode], env)
                finally:
                    os._exit(127)  # Never run parent cleanup in the forked child.
            self.resize(40, 12)
            self.wait(lambda: any(e["event"] == "ready" for e in self.events()))
            self.ready = True
            self.pump(0.2)
        except BaseException:
            self.close()
            raise

    def events(self):
        return [json.loads(line) for line in self.probe.read_text().splitlines() if line.endswith("}")]

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
                del self.raw[:-65536]  # Bounded diagnostic tail, not an unbounded transcript.
                if b"\x1b[?u" in data:
                    os.write(self.fd, b"\x1b[?1u")
                if b"\x1b[6n" in data:
                    os.write(self.fd, b"\x1b[1;1R")

    def wait(self, predicate, timeout=12):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pump()
            if predicate():
                return
        raise AssertionError(f"Timed out {self.mode}: {self.events()[-3:]}; {bytes(self.raw[-1500:])!r}")

    def key(self, data):
        os.write(self.fd, data)
        self.pump()

    def resize(self, width, height):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)

    def command(self, stage):
        self.key(b"\x1b[200~/ui-acceptance " + stage.encode() + b"\x1b[201~")
        self.key(b"\r")
        self.wait(lambda: bool(self.frames(stage)))

    def frames(self, stage):
        return [e for e in self.events() if e["event"] == "frame" and e["stage"] == stage]

    def results(self, stage):
        return [e for e in self.events() if e["event"] == "result" and e["stage"] == stage]

    def frame(self, stage, width, height):
        self.resize(width, height)
        self.wait(lambda: bool(self.frames(stage)) and
                  self.frames(stage)[-1]["width"] == width and self.frames(stage)[-1]["rows"] == height)
        frame = self.frames(stage)[-1]
        check(len(frame["lines"]) <= height, "composited frame height")
        return frame, "\n".join(ANSI.sub("", line) for line in frame["lines"])

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            if self.pid is not None:
                try:
                    if self.ready:
                        for key in [b"\x1b", b"\x03", b"\x03", b"\x04"]:
                            self.key(key)
                    else:
                        os.kill(self.pid, signal.SIGTERM)
                except OSError:
                    pass
                for attempt in range(20):
                    try:
                        if os.waitpid(self.pid, os.WNOHANG)[0]:
                            break
                        if attempt == 10:
                            os.kill(self.pid, signal.SIGTERM)
                    except (ProcessLookupError, ChildProcessError):
                        break
                    self.pump(0.1)
                else:
                    try:
                        os.kill(self.pid, signal.SIGKILL)
                        os.waitpid(self.pid, 0)
                    except (ProcessLookupError, ChildProcessError):
                        pass
        finally:
            try:
                if self.fd is not None:
                    os.close(self.fd)
            finally:
                if self.temp is not None:
                    self.temp.cleanup()
            (OUT / f"{self.mode}.ansi").write_bytes(self.raw)


for mode in (["regular", "fullscreen"] if __name__ == "__main__" else []):
    host = Host(mode)
    try:
        host.command("editor")
        for width, height in [(40, 12), (100, 30), (40, 12)]:
            frame, text = host.frame("editor", width, height)
            check("line-34 中文" in text, "last prefill line survives actual host clipping")
            check("accept" in text and "cancel" in text, "essential review controls visible")
            check(not frame["hardwareCursor"], "default hardware cursor disabled")
            check("\x1b[7m" in "\n".join(frame["lines"]), "software cursor inverse preserved")
        host.frame("editor", 1, 12)
        host.key(b"\r")
        check(not host.results("editor"), "tiny resize cannot approve")
        host.frame("editor", 40, 12)
        host.key(b"\r")
        host.wait(lambda: bool(host.results("editor")))
        expected = "\n".join(f"line-{i:02d} 中文" for i in range(35))
        check(host.results("editor")[-1]["value"] == expected, "native approval preserves complete text")
        host.command("picker")
        for width, height in [(40, 12), (100, 30), (40, 12)]:
            frame, text = host.frame("picker", width, height)
            check("preview" in text and "cancel" in text, "picker help visible")
            check("\x1b[7m" in "\n".join(frame["lines"]), "filter insertion cell visible")
        host.key(b"39")
        host.key(b"\r")
        host.wait(lambda: bool(host.results("picker")))
        check(host.results("picker")[-1]["value"]["id"] == "id-39", "native filter selects expected row")
        host.command("choice")
        for width, height in [(40, 12), (100, 30), (40, 12)]:
            host.frame("choice", width, height)
            for _ in range(12):
                host.key(b"\x1b[6~")
            _, text = host.frame("choice", width, height)
            check("END OF PREVIEW" in text, "preview tail reachable")
            check("No" in text and "Yes" in text and "cancel" in text, "choices and help visible")
        host.key(b"\x1b[B")
        host.key(b"\r")
        host.wait(lambda: bool(host.results("choice")))
        check(host.results("choice")[-1]["value"] is True, "native choice accepts")
        host.command("exact")
        host.frame("exact", 40, 12)
        host.key(b"\r")
        host.wait(lambda: bool(host.results("exact")))
        check(host.results("exact")[-1]["value"] == "    return value\n",
              "approval retains exact leading/trailing whitespace")
        host.command("insert")
        host.frame("insert", 40, 12)
        host.key(b"\x01")
        # Split payload escape sequences across real PTY writes. Pasted arrows
        # and Ctrl+C are data, never native navigation/cancellation commands.
        host.key(b"\x1b[200~X\x1b[31")
        host.key("m\x1b]52;c;secret\x07\u202e\x1b[A\x03\x1b[201~".encode())
        host.key(b"Y")
        _, text = host.frame("insert", 40, 12)
        check("XYabcd" in text and "secret" not in text, "safe paste retains mid-document cursor")
        host.key(b"\x1f")
        _, text = host.frame("insert", 40, 12)
        check("Xabcd" in text, "Undo removes following typing first")
        host.key(b"\x1f")
        _, text = host.frame("insert", 40, 12)
        check("abcd" in text and "Xabcd" not in text, "second Undo atomically removes sanitized paste")
        host.key(b"\r")
        host.wait(lambda: bool(host.results("insert")))
        check(host.results("insert")[-1]["value"] == "abcd", "Undo restores exact pre-paste document")
        host.command("picker-cursor")
        host.frame("picker-cursor", 40, 12)
        host.key(b"abcd")
        host.key(b"\x01")
        host.key("\x1b[200~X\u202e\x1b[201~".encode())
        host.key(b"Y")
        _, text = host.frame("picker-cursor", 40, 12)
        check("XYabcd" in text and "XaYbcd" not in text, "native filter cursor tracks sanitized text")
        host.key(b"\r")
        host.wait(lambda: bool(host.results("picker-cursor")))
        check(host.results("picker-cursor")[-1]["value"]["id"] == "cursor-0", "picker selects correct safe filter")
    finally:
        host.close()
if __name__ == "__main__":
    print(f"PASS: {checks} real CLI/PTY assertions; artifacts: {OUT}")
