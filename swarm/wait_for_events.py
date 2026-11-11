"""Wait for orchestration events with one bounded blocking call, and say what came back.

Why this exists: a session waiting for another agent used to `sleep 600`, then wake, re-read the
inbox, sleep again. The measured cost was 618 s of blind waiting in ten sleeps, and the failure
mode is worse than the cost — after a long sleep the model has to re-derive what it was waiting
for, which is how a wake turns into an action nobody authorized.

The contract this implements is the CLI's, not an invention:

* `check --wait` returns the whole FIFO Delivery. `--types` decides what wakes the call, never
  what the call returns, so the caller must dispatch by each row's own type.
* A `_keepalive` line arrives on stderr every 15 s. It is CLI liveness, so it is filtered here and
  never becomes part of the message stream.
* One call is bounded (default 300 s). `TIMEOUT` is its own status and is not "no messages": the
  caller may enumerate again, and that is all it may do.

Exit status is the classification, so a shell caller cannot mistake one case for another:
0 = messages, 3 = empty batch, 124 = timeout, 2 = usage or transport failure.
Nothing here starts, releases, abandons or retries anything; that authority stays with the caller.

Standard library only, like the rest of this directory.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

MESSAGES = 0
USAGE_OR_TRANSPORT = 2
EMPTY = 3
TIMEOUT = 124
DEFAULT_TIMEOUT_MS = 300_000
DEFAULT_TYPES = "worker_done,escalation,question"


def classify(returncode: int, stdout: str) -> tuple[int, dict | list | None]:
    """Map one CLI result to a status. A timeout in the receipt outranks the exit code."""
    payload: dict | list | None = None
    for line in stdout.splitlines():
        line = line.strip()
        if not line or line.startswith("_keepalive"):
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue
    if returncode == TIMEOUT or (isinstance(payload, dict) and payload.get("timeout") is True):
        return TIMEOUT, payload
    if returncode != 0:
        return USAGE_OR_TRANSPORT, payload
    if payload is None:
        return EMPTY, payload
    rows = payload.get("deliveries") if isinstance(payload, dict) else payload
    return (MESSAGES if rows else EMPTY), payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", default="orca", help="executable to call (default: orca)")
    parser.add_argument("--types", default=DEFAULT_TYPES, help="what wakes the call, not a filter")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS,
                        help="one bounded call; re-enter instead of asking for a longer window")
    parser.add_argument("--terminal", help="caller handle, when not inside the coordinator terminal")
    parser.add_argument("--run", help="bound Run id, when not using the caller's")
    parser.add_argument("--json", action="store_true", help="print the raw receipt to stdout")
    args = parser.parse_args(argv)
    if args.timeout_ms <= 0:
        parser.error("--timeout-ms must be positive")

    command = [args.cli, "orchestration", "check", "--wait", "--types", args.types,
               "--timeout-ms", str(args.timeout_ms), "--json"]
    if args.terminal:
        command += ["--terminal", args.terminal]
    if args.run:
        command += ["--run", args.run]
    completed = subprocess.run(command, capture_output=True, text=True)
    # Why stderr is only forwarded on failure: it is keepalive plus diagnostics, and the caller's
    # message stream must stay parseable.
    status, payload = classify(completed.returncode, completed.stdout)
    if status == TIMEOUT:
        print("timeout: no wake within the window; enumerate and re-enter, do not act",
              file=sys.stderr)
        return TIMEOUT
    if status == EMPTY:
        print("empty: the batch held no messages; enumerate and re-enter, do not act",
              file=sys.stderr)
        return EMPTY
    if status == USAGE_OR_TRANSPORT:
        print(f"check failed with exit {completed.returncode}", file=sys.stderr)
        if completed.stderr:
            print(completed.stderr.rstrip(), file=sys.stderr)
        return USAGE_OR_TRANSPORT
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        rows = payload.get("deliveries") if isinstance(payload, dict) else payload
        for row in rows:
            print(f"{row.get('type', 'unknown')}\t{json.dumps(row, ensure_ascii=False)}")
    return MESSAGES


if __name__ == "__main__":
    raise SystemExit(main())
