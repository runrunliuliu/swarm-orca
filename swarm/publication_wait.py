"""Wake as soon as a file is published, but never rely on that wake.

Why: two strict-start waits poll with `time.sleep(0.25)` for a file another process publishes. On
this NFSv4.1 mount a same-client publish is visible to inotify in 1-2 ms (measured: 40/40 files,
no losses), so polling spends 250 ms of latency for nothing. But the cross-client case is
unmeasured and, on Linux NFSv4.1 with `acdirmax=30s`, an event may never arrive at all.

So the contract here is: **inotify may only shorten a wait, never define it**. The caller keeps its
deadline and its `lstat`; `idle()` blocks at most `fallback` seconds and always returns, whether an
event arrived or not. If inotify cannot be opened at all, `watch()` returns None and `idle(None, s)`
is plain `time.sleep(s)` - a deployment where events never arrive therefore degrades to exactly
today's behaviour instead of hanging.

`stats` exists so a deployment can observe which path it is on: a high `timeouts` count next to a
low `events` count means inotify is not delivering there, and the fallback period is the real
delivery latency.
"""

from __future__ import annotations

import ctypes
import os
import select
import time

IN_CREATE = 0x00000100
IN_CLOSE_WRITE = 0x00000008
IN_MOVED_TO = 0x00000080
MASK = IN_CREATE | IN_CLOSE_WRITE | IN_MOVED_TO


class Watcher:
    """One directory watch for one target name, with counters a deployment can log."""

    def __init__(self, directory: str, name: str) -> None:
        self.name = name
        self.events = 0
        self.timeouts = 0
        self._libc = ctypes.CDLL("libc.so.6", use_errno=True)
        self._fd = self._libc.inotify_init1(os.O_NONBLOCK)
        if self._fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init1 failed")
        wd = self._libc.inotify_add_watch(self._fd, directory.encode(), MASK)
        if wd < 0:
            os.close(self._fd)
            self._fd = -1
            raise OSError(ctypes.get_errno(), "inotify_add_watch failed")
        self._poller = select.poll()
        self._poller.register(self._fd, select.POLLIN)

    def wait(self, seconds: float) -> bool:
        """Block up to `seconds` in total. True only when the target name appeared.

        Why the loop: the directory usually holds other traffic (receipts, intents, temp files).
        Returning as soon as *any* event arrives made the caller re-enter its loop immediately and
        spin until its deadline - eight modules failed with `strict_start_wait_expired` before this
        was a loop. Unrelated events are consumed and the wait continues until the target appears
        or the budget is spent.
        """
        import struct

        if seconds <= 0:
            return False
        deadline = time.monotonic() + seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.timeouts += 1
                return False
            if not self._poller.poll(max(1, int(remaining * 1000))):
                self.timeouts += 1
                return False
            try:
                data = os.read(self._fd, 65536)
            except BlockingIOError:
                continue
            offset = 0
            while offset + 16 <= len(data):
                _wd, _mask, _cookie, length = struct.unpack_from("iIII", data, offset)
                name = data[offset + 16:offset + 16 + length].split(b"\0")[0].decode(errors="replace")
                offset += 16 + length
                self.events += 1
                if name == self.name:
                    return True

    def close(self) -> None:
        if self._fd >= 0:
            os.close(self._fd)
            self._fd = -1


def watch(target) -> Watcher | None:
    """A watcher for `target`'s parent directory, or None when inotify is unavailable."""
    from pathlib import Path

    path = Path(target)
    try:
        return Watcher(str(path.parent), path.name)
    except (OSError, AttributeError):
        return None


def idle(watcher: Watcher | None, seconds: float) -> bool:
    """Wait up to `seconds` for a publication; False means "re-check by polling"."""
    if watcher is None:
        time.sleep(max(0.0, seconds))
        return False
    return watcher.wait(seconds)
