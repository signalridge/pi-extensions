"""One-shot Linux diagnostic rescue only; no numeric-PID signal fallback."""
import errno
import json
import os
import signal
import sys


class Kernel:
    open = staticmethod(lambda pid: os.pidfd_open(pid, 0))
    send = staticmethod(lambda fd: signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0))
    close = staticmethod(os.close)
    self_pid = staticmethod(os.getpid)
    uid = staticmethod(lambda: os.getuid())

    @staticmethod
    def identity(pid):
        with open(f"/proc/{pid}/stat", encoding="utf8") as source:
            raw = source.read()
        end = raw.rfind(")")
        fields = raw[end + 2:].split()
        if end < 0 or len(fields) < 20:
            raise ValueError("invalid proc stat")
        with open(f"/proc/{pid}/status", encoding="utf8") as source:
            uids = [line.split()[1:] for line in source if line.startswith("Uid:")]
        if len(uids) != 1 or len(uids[0]) != 4 or len(set(uids[0])) != 1:
            raise ValueError("unconfirmed UID")
        return dict(pid=int(raw.split(" ", 1)[0]), state=fields[0],
                    pgid=int(fields[2]), sid=int(fields[3]),
                    starttime=fields[19], uid=int(uids[0][0]))


def rescue(request, backend):
    """Acquire first, validate second, send ONLY through that held descriptor."""
    fd = None
    result = dict(status="refused", reason="invalid identity")
    try:
        expected = request["expected"]
        keys = ("pid", "pgid", "sid", "uid")
        if any(type(expected[key]) is not int for key in keys):
            return result
        pid = expected["pid"]
        if (pid <= 1 or expected["pgid"] <= 1 or expected["sid"] <= 1
                or expected["uid"] != backend.uid()
                or not isinstance(expected["starttime"], str)
                or not expected["starttime"].isdigit()
                or type(request["self"]) is not int
                or not isinstance(request["forbidden"], list)
                or any(type(item) is not int for item in request["forbidden"])
                or pid in [backend.self_pid(), request["self"], *request["forbidden"]]):
            return result
        fd = backend.open(pid)
        # /proc can now disappear/change, but the descriptor cannot retarget a
        # replacement PID. A pre-acquisition replacement fails this identity read.
        observed = backend.identity(pid)
        if (any(observed[key] != expected[key] for key in (*keys, "starttime"))
                or observed["state"] not in ("R", "S", "D", "T", "t", "I")):
            result = dict(status="refused", reason="identity changed or not live", observed=observed)
        else:
            backend.send(fd)
            result = dict(status="sent", observed=observed)
    except ProcessLookupError:
        result = dict(status="gone", errno="ESRCH")
    except OSError as error:
        # ENOENT from /proc after open is NOT proof of a successful rescue.
        result = dict(status="refused", errno=errno.errorcode.get(error.errno, "UNKNOWN"))
    except (AttributeError, KeyError, TypeError, ValueError, NotImplementedError):
        result = dict(status="refused", reason="unsupported or unreadable identity")
    finally:
        if fd is not None:
            try:
                backend.close(fd)
            except OSError as error:
                result = dict(status="refused", reason="pidfd close failed",
                              errno=errno.errorcode.get(error.errno, "UNKNOWN"))
    return result


def probe():
    if sys.platform != "linux" or sys.version_info < (3, 9):
        raise RuntimeError("Linux Python >=3.9 with pidfd APIs required")
    fd = os.pidfd_open(os.getpid(), 0)
    try:
        signal.pidfd_send_signal(fd, 0, None, 0)  # self-only capability probe, not rescue
        Kernel.identity(os.getpid())
    finally:
        os.close(fd)
    return dict(supported=True, version=sys.version, executable=os.path.realpath(sys.executable),
                pidfd_open=True, pidfd_send_signal=True)


if __name__ == "__main__":
    try:
        result = probe() if sys.argv[1:] == ["--probe"] else rescue(json.loads(sys.stdin.read(4096)), Kernel())
    except Exception:
        result = dict(status="refused", reason="pidfd prerequisite or request failed")
    print(json.dumps(result))
