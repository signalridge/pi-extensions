#!/usr/bin/env python3
"""Finite, offline, repo-pinned native Pi 1.5 PTY acceptance (Python stdlib only).
Run from any cwd: python3 scripts/workflow-cli.py [--artifacts /tmp/new-directory]
No real inference, user environment/resources, private host fields, or SDK tool bypass.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import termios
import time
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HOST = ROOT / "node_modules/@earendil-works/pi-coding-agent"
CLI = HOST / "dist/cli.js"
FIXTURE = ROOT / "scripts/fixtures/workflow-cli.ts"
GUARD = ROOT / "scripts/fixtures/cli-guard.cjs"
CAPTURE = b"\x1b[100;7u"
ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[=>]")
CHECKS = 0


def check(value, message):
    global CHECKS
    assert value, message
    CHECKS += 1


def jsonlines(path):
    if not path.exists():
        return []
    # Ignore only a final partial write; completed invalid records must fail.
    return [json.loads(line) for line in path.read_text().splitlines(keepends=True) if line.endswith("\n")]


def group_members(group):
    output = subprocess.check_output(["ps", "-axo", "pid=,pgid="], text=True)
    return [int(pid) for pid, pgid in (row.split() for row in output.splitlines()) if int(pgid) == group]


class Host:
    def __init__(self, path, mode, order, fleet, notice=None):
        self.path = path
        sandbox = notice["sandbox"] if notice else path
        path.mkdir(parents=True, exist_ok=True)
        self.raw = bytearray()
        self.reaped = False
        self.status = None
        self.fd = None
        for name in ("home", "agent", "cwd/.pi", "sessions", "cache", "tmp"):
            (sandbox / name).mkdir(parents=True, exist_ok=True)
        self.probe = path / "probe.jsonl"
        self.processes = path / "processes.jsonl"
        if not notice:
            (path / "agent/settings.json").write_text(json.dumps({
                "quietStartup": True, "checkForUpdates": False, "enableInstallTelemetry": False,
                "compaction": {"enabled": False}, "retry": {"enabled": False},
                "terminal": {"images": False, "hyperlinks": False},
            }))
            (path / "cwd/.pi/subagents.json").write_text(json.dumps({"schedulingEnabled": False, "fleetView": fleet}))
        node = shutil.which("node")
        assert node, "Node is required"
        env = {
            "PATH": str(Path(node).parent) + ":/usr/bin:/bin", "HOME": str(sandbox / "home"),
            "PI_CODING_AGENT_DIR": str(sandbox / "agent"), "PI_CODING_AGENT_SESSION_DIR": str(sandbox / "sessions"),
            "XDG_CONFIG_HOME": str(sandbox / "home/config"), "XDG_CACHE_HOME": str(sandbox / "cache"),
            "XDG_DATA_HOME": str(sandbox / "home/data"), "TMPDIR": str(sandbox / "tmp"),
            "JITI_FS_CACHE": "false", "JITI_CACHE": "false", "TERM": "xterm-256color", "COLORTERM": "truecolor",
            "LANG": "en_US.UTF-8", "PI_OFFLINE": "1", "PI_TELEMETRY": "0", "PI_TRUE_COLOR": "1", "PI_PROGRAM_STATUS": "0",
            "PI_CLI_SANDBOX": str(sandbox), "PI_CLI_PROCESSES": str(self.processes),
            "WORKFLOW_CLI_PROBE": str(self.probe), "WORKFLOW_CLI_ORDER": order,
            "NODE_OPTIONS": "--require=" + str(GUARD),
        }
        args = [node, str(CLI), "--offline", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-mcp",
                "--no-builtin-tools", "--no-approve", "-e", str(FIXTURE), "--model", "workflow-cli-faux/offline", "--thinking", "off", "--tui-mode", mode]
        if notice:
            # Only this generated local package is discoverable in the disposable HOME.
            # Native package provenance (not an explicit top-level -e module) owns notices.
            args = [node, str(CLI), "--offline", "-ns", "-np", "-nc", "--no-themes", "--no-mcp", "--no-builtin-tools",
                    "--no-approve", "--model", "notice-cli-faux/offline", "--tui-mode", mode]
            args += ["--session", str(notice["session"])] if notice.get("session") else ["--no-session"]
        (path / "invocation.json").write_text(json.dumps({"args": args, "env": env, "cwd": str(sandbox / "cwd")}, indent=2))
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(sandbox / "cwd")
            os.execve(node, args, env)
        try:
            self.resize(120, 40)
        except BaseException:
            self.close()
            raise

    def events(self, name=None):
        events = jsonlines(self.probe)
        return [event for event in events if name is None or event["event"] == name]

    def pump(self, duration=.08):
        end = time.monotonic() + duration
        while time.monotonic() < end:
            ready, _, _ = select.select([self.fd], [], [], max(0, end - time.monotonic()))
            if not ready:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return
            if not data:
                return
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
        raise AssertionError(f"Timeout at {self.path}; events={self.events()[-3:]}; PTY={bytes(self.raw[-2000:])!r}")

    def key(self, data):
        os.write(self.fd, data)
        self.pump()

    def paste(self, text):
        self.key(b"\x1b[200~" + text.encode() + b"\x1b[201~")

    def command(self, text):
        self.key(b"\x05\x15")
        self.paste(text)
        self.key(b"\r")

    def resize(self, width, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, width, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)

    def capture(self):
        count = len(self.events("capture"))
        start = len(self.raw)
        self.key(CAPTURE)
        self.wait(lambda: len(self.events("capture")) > count)
        self.pump(.15)
        return self.events("capture")[-1], ANSI.sub("", bytes(self.raw[start:]).decode(errors="replace"))

    def snapshot(self):
        values = self.events("snapshot")
        return values[-1]["snapshot"]["runs"] if values else []

    def poll_exit(self):
        if self.reaped:
            return True
        pid, status = os.waitpid(self.pid, os.WNOHANG)
        if pid:
            self.reaped = True
            self.status = status
        return self.reaped

    def close(self):
        # Defer (do not discard) secondary interrupts/alarms until cleanup finishes.
        # A pending whole-suite alarm must still fail the suite after reaping.
        signals = (signal.SIGTERM, signal.SIGINT, signal.SIGALRM)
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
        forced = []
        try:
            if not self.reaped:
                try:
                    self.command("/acceptance-exit")
                    self.wait(self.poll_exit, 8)
                except (OSError, AssertionError):
                    pass
            # A failed exec/preload may close the PTY before command() reaches wait().
            # Reap that exited leader before attempting to signal its zombie group.
            self.poll_exit()
            # All descendants normally share the pty.fork session/group. Reap even
            # after the leader exited: a successful waitpid alone is not cleanup.
            survivors = group_members(self.pid)
            if survivors:
                forced.append("SIGTERM")
                os.killpg(self.pid, signal.SIGTERM)
                end = time.monotonic() + 2
                while time.monotonic() < end and group_members(self.pid):
                    self.pump(.1)
                    self.poll_exit()
            if group_members(self.pid):
                forced.append("SIGKILL")
                os.killpg(self.pid, signal.SIGKILL)
            if not self.reaped:
                _, self.status = os.waitpid(self.pid, 0)
                self.reaped = True
            end = time.monotonic() + 2
            while group_members(self.pid) and time.monotonic() < end:
                self.pump(.1)
            check(not group_members(self.pid), "all owned process-group members exited")
            # Helpers inherit the preload; every helper start must have disappeared,
            # not just the host. No signal is sent to historical/PID-reused children.
            children = [e for e in jsonlines(self.processes) if e["event"] == "process-start" and e["pid"] != self.pid]
            for child in children:
                try:
                    os.kill(child["pid"], 0)
                except ProcessLookupError:
                    continue
                raise AssertionError(f"Owned helper still exists: {child}")
            check(not [e for e in jsonlines(self.processes) if e["event"] == "network-denied"], "no network attempt")
        finally:
            try:
                (self.path / "terminal.ansi").write_bytes(self.raw)
                (self.path / "cleanup.json").write_text(json.dumps({"pid": self.pid, "reaped": self.reaped, "status": self.status, "forced": forced, "remaining_group": group_members(self.pid)}, indent=2))
            finally:
                if self.fd is not None:
                    os.close(self.fd)
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def run(path, mode, order, fleet):
    host = Host(path, mode, order, fleet)
    try:
        # Cold Jiti compilation of both full packages is included; no cache/user resources.
        host.wait(lambda: bool(host.events("ready")), 30)
        host.command("Start three workflows for offline acceptance")
        host.wait(lambda: bool(host.events("settled")))
        host.wait(lambda: len(host.snapshot()) == 3 and all(r.get("currentPhase", "").startswith("AWAIT_") for r in host.snapshot()))
        owned = {run["runId"] for run in host.snapshot()}
        check(len(owned) == 3, "three distinct real workflow IDs")
        check(all(r["status"] == "running" and r["callCount"] == 0 and "tokenCount" not in r for r in host.snapshot()), "childless pending runs; no invented usage")
        check(host.events("settled")[-1]["calls"] == 2, "root naturally finished after real tool calls")
        starts = [e for e in jsonlines(host.processes) if e["event"] == "process-start" and e["pid"] != host.pid]
        check(len(starts) == 3, "three real owned VM helpers, no managed model sessions")
        host.paste("DRAFT_BOUNDARY_中")
        host.wait(lambda: any("CLI_ALPHA_中" in "\n".join(e["lines"]) for e in host.events("widget-frame")))
        frame, raw = host.capture()
        check(frame["idle"] and frame["calls"] == 2, "background-only idle root")
        overview = frame["widgets"].get("pi-workflows")
        check(overview and overview["placement"] == "belowEditor", "overview mounted below native editor")
        live = "\n".join("\n".join(w["lines"]) for w in frame["widgets"].values())
        check(live.count("Workflows ·") == 1, "exactly one live overview header")
        for name in ("CLI_ALPHA_中", "CLI_BETA_é", "CLI_GAMMA_👩‍💻"):
            check(live.count(name) == 1, "each run occurs once across all live widgets: " + name)
            check(name in raw, "actual forced PTY redraw contains " + name)
        check("fleet" not in frame["widgets"], "no duplicate Fleet workflow widget")
        check(all(f"AWAIT_{index}_中" in live for index in range(3)), "observed phases rendered in complete overview")
        check("DRAFT_BOUNDARY_中" in raw and raw.index("DRAFT_BOUNDARY_中") < raw.index("Workflows ·"), "PTY editor-before-overview placement")
        check("\x1b[" in bytes(host.raw).decode(errors="replace"), "native ANSI stream captured")
        # Both CLI renderers receive real SIGWINCH; small heights must summarize,
        # not pretend every run remains visible. Widths >=20 avoid host editor edge cases.
        for width, rows in ((72, 24), (40, 16), (20, 8), (120, 40)):
            host.resize(width, rows)
            host.wait(lambda: any(e["key"] == "pi-workflows" and e["width"] == width and e["rows"] == rows for e in host.events("widget-frame")))
            resized = [e for e in host.events("widget-frame") if e["key"] == "pi-workflows" and e["width"] == width and e["rows"] == rows][-1]
            check(len(resized["lines"]) <= min(12, rows // 4), "bounded overview rows")
            check(all(n <= width for n in resized["columns"]), "ANSI/Unicode terminal columns bounded")
            if rows == 8:
                check(any("3 more workflow" in line for line in resized["lines"]), "short viewport honestly summarizes hidden rows")
        host.command("/workflows")
        host.wait(lambda: bool(host.events("inspector-frame")))
        check(any("Workflows" in "\n".join(e["lines"]) for e in host.events("inspector-frame")), "real workflows inspector rendered")
        for width, rows in ((72, 24), (40, 16), (20, 8), (120, 40)):
            start = len(host.events("inspector-frame"))
            host.resize(width, rows)
            host.wait(lambda: len(host.events("inspector-frame")) > start and host.events("inspector-frame")[-1]["rows"] == rows)
            inspector = host.events("inspector-frame")[-1]
            check(len(inspector["lines"]) <= rows and all(n <= width for n in inspector["columns"]), "native inspector resize is bounded")
        host.key(b"\x1b")
        host.wait(lambda: bool(host.events("close")))
        check({r["runId"] for r in host.snapshot()} == owned and all(r["status"] == "running" for r in host.snapshot()), "closing inspector leaves owned workflows running")
        after_inspector, _ = host.capture()
        check(after_inspector["calls"] == 2, "inspection does not infer")
        host.command("Stop only the acceptance workflows")
        host.wait(lambda: len(host.snapshot()) == 3 and all(r["status"] == "stopped" for r in host.snapshot()))
        host.wait(lambda: len(host.events("settled")) >= 2)
        controls = [e for e in host.events("tool-end") if e["name"] == "workflow_control"]
        check(len(controls) == 3 and all(not e["error"] for e in controls), "three normal public stop-tool results")
        check({e["result"]["details"]["run"]["runId"] for e in controls} == owned, "stop targets only owned exact IDs")
        host.command("/acceptance-exit")
        host.wait(host.poll_exit, 8)
        check(host.status == 0 and bool(host.events("shutdown")), "normal native CLI lifecycle exit")
        check(not group_members(host.pid), "owned VM helpers reaped by normal lifecycle, before safety cleanup")
        print(f"PASS {mode} {order} fleet={fleet}", flush=True)
    finally:
        host.close()


def notices(path, mode):
    path.mkdir(parents=True)
    package = path / "fixture-package"
    package.mkdir()
    shutil.copyfile(ROOT / "scripts/fixtures/notice-cli.ts", package / "index.ts")
    (path / "agent").mkdir()
    settings_path = path / "agent/settings.json"
    settings_path.write_text(json.dumps({"packages": [str(package)], "quietStartup": True,
                                        "checkForUpdates": False, "enableInstallTelemetry": False,
                                        "collapseChangelog": False, "retry": {"enabled": False}}))
    changelog = ""

    def version(value):
        nonlocal changelog
        marker = "NOTICE_BODY_" + value.replace(".", "_")
        (package / "package.json").write_text(json.dumps({"name": "pi-cli-notice-fixture", "version": value,
            "type": "module", "pi": {"extensions": ["index.ts"], "changelogPath": "CHANGELOG.md"}}))
        changelog = f"## [{value}]\n\n{marker}\n\n" + changelog
        (package / "CHANGELOG.md").write_text("# Changelog\n\n" + changelog)
        return marker

    def launch(label, session=None, prompt=False):
        host = Host(path / label, mode, "", False, {"sandbox": path, "session": session})
        try:
            host.wait(lambda: bool(host.events("ready")), 30)
            host.pump(.2)
            if prompt:
                host.command("Persist this synthetic notice fixture session")
                host.wait(lambda: bool(host.events("settled")))
                check(host.events("settled")[-1]["calls"] == 1, "notice persistence uses faux provider only")
            text = ANSI.sub("", bytes(host.raw).decode(errors="replace"))
            reason = host.events("ready")[-1]["reason"]
            host.command("/acceptance-exit")
            host.wait(host.poll_exit, 8)
            check(host.status == 0 and bool(host.events("shutdown")), "notice native CLI graceful exit")
            return text, reason, json.loads(settings_path.read_text()).get("extensionChangelogVersions", {})
        finally:
            host.close()

    original = version("1.0.0")
    session = path / "sessions/notice-session.jsonl"
    text, _, seen = launch("first-seen", session=session, prompt=True)
    check(original not in text and "Extension Updates" not in text, "first-seen package records silently")
    check(list(seen.values()) == ["1.0.0"], "host records first-seen package version")
    check(session.exists(), "real native session persisted for resume")
    expanded = version("1.1.0")
    text, _, seen = launch("upgrade-expanded")
    check("Extension Updates" in text and expanded in text and original not in text, "native upgrade shows only new changelog entry")
    check(list(seen.values()) == ["1.1.0"], "native upgrade acknowledgement persisted")
    text, _, _ = launch("already-seen")
    check(expanded not in text and "Extension Updates" not in text, "acknowledged notice is not repeated")
    collapsed = version("1.2.0")
    settings = json.loads(settings_path.read_text())
    settings["collapseChangelog"] = True
    settings_path.write_text(json.dumps(settings))
    text, _, seen = launch("upgrade-collapsed")
    check("Updated pi-cli-notice-fixture to v1.2.0." in text and collapsed not in text, "native collapse uses compact summary, not body")
    check(list(seen.values()) == ["1.2.0"], "collapsed upgrade acknowledged natively")
    resumed = version("1.3.0")
    text, reason, seen = launch("resumed", session=session)
    # Host startup reason is startup even when loading --session; session messages,
    # not a synthetic event reason, are the native changelog suppression boundary.
    check(reason == "startup" and "NOTICE_SESSION_PERSISTED" in text, "real persisted conversation resumed")
    check(resumed not in text and "Updated pi-cli-notice-fixture" not in text, "native resume suppresses pending upgrade notice")
    check(list(seen.values()) == ["1.2.0"], "resume does not consume unseen upgrade")
    text, _, seen = launch("fresh-after-resume")
    check("Updated pi-cli-notice-fixture to v1.3.0." in text and list(seen.values()) == ["1.3.0"], "fresh session still receives upgrade skipped on resume")
    print(f"PASS {mode} native package notice first-seen/upgrade/repeat/collapse/resume", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path)
    parser.add_argument("--lane", choices=("all", "workflows", "notices"), default="all")
    args = parser.parse_args()
    check(json.loads((HOST / "package.json").read_text())["version"] == "1.5.0", "repository CLI is exactly 1.5.0")
    path = args.artifacts or Path(tempfile.mkdtemp(prefix="pi15-workflow-cli-", dir="/tmp"))
    if args.artifacts:
        path.mkdir(exist_ok=False, parents=True)
    path = path.resolve()
    check(str(path).startswith(("/tmp/", "/private/tmp/")), "artifacts are disposable /tmp only")
    print("Artifacts:", path, flush=True)
    # A finite whole-suite wall-clock guard, independent of product deadlines.
    def terminated(signum, _frame):
        raise SystemExit(f"acceptance interrupted: signal {signum}")
    signal.signal(signal.SIGTERM, terminated)
    signal.signal(signal.SIGALRM, terminated)
    signal.alarm(360)
    try:
        for mode in ("regular", "fullscreen"):
            if args.lane != "notices":
                for order in ("workflows,subagents", "subagents,workflows"):
                    for fleet in (True, False):
                        run(path / f"{mode}-{order.replace(',', '-')}-fleet-{fleet}", mode, order, fleet)
            if args.lane != "workflows":
                notices(path / f"notices-{mode}", mode)
        (path / "result.json").write_text(json.dumps({"checks": CHECKS, "status": "passed"}, indent=2))
        print(f"PASS {CHECKS} native CLI checks", flush=True)
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    main()
