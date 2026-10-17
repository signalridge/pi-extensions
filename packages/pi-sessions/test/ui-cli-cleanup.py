"""Bounded constructor-failure regression; runs a real owned PTY child, no Pi/provider."""
import importlib.util
import os
from pathlib import Path
import pty
import signal
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ui_cli", Path(__file__).with_name("ui-cli.py"))
ui_cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui_cli)


class ConstructionCleanup(unittest.TestCase):
    def test_readiness_timeout_closes_child_fd_and_temp_directory(self):
        real_fork = pty.fork
        native_wait = ui_cli.Host.wait
        host = ui_cli.Host.__new__(ui_cli.Host)

        def sleeping_child():
            pid, fd = real_fork()
            if pid == 0:
                time.sleep(30)
                os._exit(0)
            return pid, fd

        with tempfile.TemporaryDirectory(prefix="sessions-cleanup-output-") as output:
            ui_cli.OUT = Path(output)
            started = time.monotonic()
            try:
                with patch.object(pty, "fork", sleeping_child), patch.object(
                    ui_cli.Host, "wait", lambda self, predicate: native_wait(self, predicate, timeout=0.1)
                ):
                    with self.assertRaisesRegex(AssertionError, "Timed out"):
                        ui_cli.Host.__init__(host, "not-ready")
                self.assertLess(time.monotonic() - started, 5)
                self.assertFalse(Path(host.temp.name).exists())
                with self.assertRaises(ChildProcessError):
                    os.waitpid(host.pid, os.WNOHANG)
                with self.assertRaises(OSError):
                    os.fstat(host.fd)
                host.close()  # Idempotent, even after failed construction.
            finally:
                # Test failure must not itself leak the pre-repair child.
                try:
                    os.kill(host.pid, signal.SIGKILL)
                    os.waitpid(host.pid, 0)
                except (ProcessLookupError, ChildProcessError):
                    pass
                try:
                    os.close(host.fd)
                except OSError:
                    pass
                host.temp.cleanup()


if __name__ == "__main__":
    unittest.main()
