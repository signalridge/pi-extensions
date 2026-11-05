"""Portable fake-kernel tests: never opens a pidfd or signals a user process."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

spec = importlib.util.spec_from_file_location("pidfd", Path(__file__).with_name("snippet-retirement-pidfd.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

EXPECTED = dict(pid=42, pgid=42, sid=42, uid=1000, starttime="12345", state="S")


class Backend:
    def __init__(self, replace_at=None, gone=False, fail=None):
        self.active = dict(EXPECTED)
        self.old = self.active
        self.replacement = dict(EXPECTED, starttime="54321")
        self.held = {}
        self.sent = []
        self.closed = []
        self.calls = []
        self.replace_at = replace_at
        self.gone = gone
        self.fail = fail

    def uid(self):
        return 1000

    def self_pid(self):
        return 98

    def open(self, pid):
        self.calls.append("open")
        if self.fail == "unsupported":
            raise AttributeError("pidfd_open")
        if self.replace_at == "before-open":
            self.active = self.replacement
        self.held[7] = self.active
        return 7

    def identity(self, pid):
        self.calls.append("read")
        if self.fail in (errno.EPERM, errno.EACCES, errno.ENOENT, errno.EIO):
            raise OSError(self.fail, "unreadable")
        if self.replace_at == "before-read":
            self.active = self.replacement
        observed = dict(self.active)
        if self.replace_at == "after-read":
            self.active = self.replacement
        return observed

    def send(self, fd):
        self.calls.append("send")
        if self.gone:
            raise ProcessLookupError(errno.ESRCH, "old task gone")
        if self.fail == "send-unsupported":
            raise AttributeError("pidfd_send_signal")
        if self.fail == "send-eperm":
            raise PermissionError(errno.EPERM, "denied")
        self.sent.append(self.held[fd])

    def close(self, fd):
        self.calls.append("close")
        self.closed.append(fd)
        if self.fail == "close":
            raise OSError(errno.EIO, "close failed")
        del self.held[fd]


def run(backend, expected=None, forbidden=None, caller=99):
    return helper.rescue(dict(expected=expected or dict(EXPECTED), self=caller,
                              forbidden=forbidden or [77]), backend)


class PidfdTests(unittest.TestCase):
    def test_replacement_between_validation_and_send_cannot_retarget_fd(self):
        for path in ("normal", "watchdog-emergency"):
            for gone in (False, True):
                with self.subTest(path=path, gone=gone):
                    backend = Backend("after-read", gone=gone)
                    result = run(backend)
                    self.assertEqual(result["status"], "gone" if gone else "sent")
                    self.assertIs(backend.active, backend.replacement)
                    if not gone:
                        self.assertIs(backend.sent[0], backend.old)
                        self.assertIsNot(backend.sent[0], backend.replacement)
                    self.assertEqual(backend.calls, ["open", "read", "send", "close"])
                    self.assertEqual(backend.closed, [7])
                    self.assertEqual(backend.held, {})

    def test_replacement_before_acquisition_or_identity_read_refuses(self):
        for path in ("normal", "watchdog-emergency"):
            for when in ("before-open", "before-read"):
                with self.subTest(path=path, when=when):
                    backend = Backend(when)
                    self.assertEqual(run(backend)["status"], "refused")
                    self.assertEqual(backend.sent, [])
                    self.assertEqual(backend.calls, ["open", "read", "close"])
                    self.assertEqual(backend.held, {})

    def test_unreadable_unknown_unsupported_or_permission_is_not_gone(self):
        for fail in ("unsupported", errno.EPERM, errno.EACCES, errno.ENOENT, errno.EIO, "send-eperm", "send-unsupported", "close"):
            with self.subTest(fail=fail):
                backend = Backend(fail=fail)
                self.assertEqual(run(backend)["status"], "refused")
                if fail != "close":
                    self.assertEqual(backend.sent, [])
                self.assertEqual(backend.closed, [] if fail == "unsupported" else [7])

    def test_identity_fields_zombies_self_and_sentinel_refuse(self):
        for changed in (dict(uid=1001), dict(pgid=43), dict(sid=43), dict(starttime="bad"), dict(pid=1)):
            backend = Backend()
            self.assertEqual(run(backend, dict(EXPECTED, **changed))["status"], "refused")
            self.assertEqual(backend.sent, [])
        for state in ("Z", "X", "?"):
            backend = Backend()
            backend.active["state"] = state
            self.assertEqual(run(backend)["status"], "refused")
            self.assertEqual(backend.closed, [7])
        for options in (dict(caller=42), dict(forbidden=[42]), dict(expected=dict(EXPECTED, pid=98))):
            backend = Backend()
            self.assertEqual(run(backend, **options)["status"], "refused")
            self.assertEqual(backend.calls, [])


def kernel_probe():
    """Explicit secondary Linux smoke on our own child only, not portable tests."""
    capability = helper.probe()
    child = subprocess.Popen([sys.executable, "-u", "-c",
                              "import sys; print('ready'); sys.stdin.read()"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             start_new_session=True, text=True)
    try:
        assert child.stdout.readline().strip() == "ready"
        expected = helper.Kernel.identity(child.pid)
        request = dict(expected=expected, self=os.getpid(), forbidden=[os.getppid()])
        before = len(os.listdir("/proc/self/fd"))
        result = helper.rescue(request, helper.Kernel())
        assert result["status"] == "sent", result
        assert len(os.listdir("/proc/self/fd")) == before, "pidfd leaked"
        assert child.wait(timeout=2) == -9, "owned child not killed/reaped"
        # A replacement acquired before validation must be refused by the real
        # helper as well. Use a fresh owned child and deliberately wrong identity.
        refused_child = subprocess.Popen([sys.executable, "-u", "-c",
                                         "import sys; print('ready'); sys.stdin.read()"],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        start_new_session=True, text=True)
        try:
            assert refused_child.stdout.readline().strip() == "ready"
            expected = helper.Kernel.identity(refused_child.pid)
            wrong = dict(expected, starttime=str(int(expected["starttime"]) + 1))
            result = helper.rescue(dict(request, expected=wrong), helper.Kernel())
            assert result["status"] == "refused", result
            assert refused_child.poll() is None, "wrong identity signalled"
        finally:
            refused_child.stdin.close()  # EOF only, never numeric rescue fallback
            refused_child.wait(timeout=2)
            refused_child.stdout.close()
        print(json.dumps(dict(label="SECONDARY Linux owned-child pidfd kernel probe", capability=capability,
                              pidfdSignal=True, wrongIdentityRefused=True, fdClosed=True, childReaped=True)))
    finally:
        child.stdin.close()  # Also releases child naturally if a prerequisite failed
        child.wait(timeout=2)
        child.stdout.close()


if __name__ == "__main__":
    if sys.argv[1:] == ["--kernel-probe"]:
        kernel_probe()
    else:
        unittest.main()
