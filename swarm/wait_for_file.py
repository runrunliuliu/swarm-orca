"""Wait for a file to appear or change, in one call, with the caller's deadline in charge.

Why: "another process will publish this marker - tell me when it does" had no callable form, so a
session slept and re-read the path. On this mount inotify delivers a same-client publish in 1-2 ms,
so the sleep bought nothing but latency and a re-derivation cost after every wake.

This is a thin shell-facing wrapper over `publication_wait`, not a second primitive: the same
`Watcher` (create/close-write/moved-to on the parent directory), the same `idle()` chunk, the same
`log()` line. The rule those carry over unchanged is that **an event may only shorten the wait,
never define it**: `st_mtime_ns`/`st_size` decide, and `--timeout-ms` bounds the call. Where inotify
cannot be opened at all, `idle()` spends the pre-change 250 ms poll period, so such a host degrades
to the loop this replaces rather than hanging.

What it does not do:

* It does not decide that a task is finished. A wake is not a receipt (I1): re-check the published
  bytes with `file_ref` and the schema, because a writer that is not atomic is visible here before
  it is complete.
* `--mode change` compares `st_mtime_ns` and `st_size`. A rewrite that lands in the same nanosecond
  with the same size is invisible, sockets and directories are not meaningful targets, and a
  partial write returns early. Writers should publish with write-then-rename or close-after-write.
* It never polls without a deadline, never retries a publication, and never returns a row it did
  not observe: exit 0 means "the file was there / the fingerprint moved", nothing more.

Exit status is the classification, like `wait_for_events.py`:
0 = appeared/changed, 124 = timeout, 2 = usage or transport failure, 4 = target unreachable
(the parent directory is missing or unreadable, or `--mode change` named a file that is not there).
Unreachable is answered immediately and is never retried into a timeout: a deadline cannot make a
directory appear, and "timed out" would invite the caller to try again.

Standard library only, like the rest of this directory.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import publication_wait

PRESENT = 0
USAGE_OR_TRANSPORT = 2
UNREACHABLE = 4
TIMEOUT = 124
DEFAULT_TIMEOUT_MS = 300_000
# One call, not one wait (I4). Asking for 900 s makes "interrupted" and "hung" the same reading,
# so a longer wait re-enters this tool instead of raising this number.
MAX_TIMEOUT_MS = 300_000
MODES = ("appear", "change")


def fingerprint(target):
    """The change byte-signature, or None when the path is not there to read.

    `stat`, not `lstat`: a published symlink is a publication of the bytes it points at, and a
    dangling one is not there yet. Only "absent" is a wait; every other error is the caller's and
    is raised so it can be reported instead of waited on.
    """
    try:
        st = os.stat(target)
    except FileNotFoundError:
        return None
    return st.st_mtime_ns, st.st_size


def precondition(target, mode):
    """A reason the wait cannot succeed, or None. Never spends the caller's window."""
    parent = os.path.dirname(os.path.abspath(target))
    try:
        if not os.path.isdir(parent):
            return f"parent directory is not reachable: {parent}"
        current = fingerprint(target)
    except OSError as error:
        return f"cannot read the target: {error.strerror or error}"
    if mode == "change" and current is None:
        return "no such file to watch for changes"
    return None


def wait(target, mode, timeout_ms):
    """(status, counters) - 0 when satisfied, 124 when the deadline won."""
    deadline = time.monotonic() + timeout_ms / 1000
    baseline = fingerprint(target) if mode == "change" else None
    # Watch once, not per iteration: a watcher per loop would re-arm inotify every fallback period
    # and lose the events it was opened for.
    watcher = publication_wait.watch(target)
    try:
        while True:
            current = fingerprint(target)
            if mode == "appear" and current is not None:
                return PRESENT, publication_wait.stats(watcher)
            if mode == "change" and current is not None and current != baseline:
                return PRESENT, publication_wait.stats(watcher)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return TIMEOUT, publication_wait.stats(watcher)
            # Re-check at least every fallback period: an event that never arrives (cross-client
            # NFS) must not leave the loop blocked past the moment the file became visible.
            publication_wait.idle(watcher,
                                  min(remaining, publication_wait.FALLBACK_SECONDS))
    finally:
        # Same diagnostic as the two strict waits: counters, so "is inotify delivering here?" is
        # answered by the log instead of by a later slowdown.
        publication_wait.log("wait_for_file", watcher)
        if watcher is not None:
            watcher.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Wait for a file to appear or change, bounded by one deadline.",
        epilog="Exit: 0 appeared/changed, 124 timeout, 2 usage/transport, 4 target unreachable. "
               "A wake is not a receipt: verify the bytes (file_ref, schema) before acting.")
    parser.add_argument("--path", required=True, help="the file another process publishes")
    parser.add_argument("--mode", choices=MODES, default="appear",
                        help="appear: wait for the path; change: wait for st_mtime_ns/st_size to move")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS,
                        help=f"the whole budget, at most {MAX_TIMEOUT_MS}; re-enter instead of "
                             "asking for a longer window")
    parser.add_argument("--json", action="store_true",
                        help="print the receipt as one JSON line (default: one word)")
    args = parser.parse_args(argv)
    if not 0 < args.timeout_ms <= MAX_TIMEOUT_MS:
        parser.error(f"--timeout-ms must be in 1..{MAX_TIMEOUT_MS}")

    reason = precondition(args.path, args.mode)
    if reason is not None:
        print(f"unreachable: {reason}", file=sys.stderr)
        return UNREACHABLE

    started = time.monotonic()
    status, counters = wait(args.path, args.mode, args.timeout_ms)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if status == TIMEOUT:
        print("timeout: nothing was published within the window; re-enter, do not act",
              file=sys.stderr)
        return TIMEOUT
    outcome = "appeared" if args.mode == "appear" else "changed"
    if args.json:
        # Diagnostics only: no path, no payload, no file content (I5).
        print(json.dumps({"event": "wait_for_file", "mode": args.mode, "outcome": outcome,
                          "elapsed_ms": elapsed_ms, **counters}, ensure_ascii=False))
    else:
        print(outcome)
    return PRESENT


if __name__ == "__main__":
    raise SystemExit(main())
