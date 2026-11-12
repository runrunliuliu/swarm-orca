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


# The real receipt, per `orca/src/shared/orchestration-check-output.ts`: the CLI wraps every
# result in `{ok, result, _meta}` and `result` carries `messages`, `count`, `deliveryId`,
# `hasOutstandingDelivery` and `timedOut`. The older guesses (`deliveries`, `timeout`) are kept
# only so an older runtime still classifies correctly.
ROW_KEYS = ("messages", "deliveries", "rows", "batch")
TIMEOUT_KEYS = ("timedOut", "timeout")


def unwrap(payload):
    """Strip the CLI's `{id, ok, result, _meta}` envelope, when there is one.

    Why not read `payload["deliveries"]` directly: the CLI wraps every command result in that
    envelope, and the row key inside `result` is not documented in the skill guide. Assuming one
    shape is how a real batch gets reported as empty, so the row list is looked for and the raw
    payload is preserved when it cannot be found.
    """
    if isinstance(payload, dict) and isinstance(payload.get("result"), (dict, list)):
        return payload["result"]
    return payload


def rows_of(payload) -> list:
    """The batch rows, or an empty list when the receipt carries none."""
    body = unwrap(payload)
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for key in ROW_KEYS:
            candidate = body.get(key)
            if isinstance(candidate, list):
                return candidate
        ignored = {"ok", "id", "_meta", "warnings", "hasOutstandingDelivery", "count"}
        leftovers = [value for key, value in body.items() if key not in ignored]
        if leftovers and not body:
            return []
        # An unrecognised non-empty body is not "no messages": surface it as one row so the
        # caller reads the receipt instead of acting on a silent empty.
        return [body] if leftovers else []
    return []


def parse(stdout: str):
    """The CLI's receipt: pretty-printed JSON on stdout, or one compact line per result."""
    text = stdout.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        pass
    payload = None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("_keepalive"):
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue
    return payload


def timed_out(payload) -> bool:
    body = unwrap(payload)
    return isinstance(body, dict) and any(body.get(key) is True for key in TIMEOUT_KEYS)


def classify(returncode: int, stdout: str) -> tuple[int, dict | list | None]:
    """Map one CLI result to a status. A timeout in the receipt outranks the exit code."""
    payload = parse(stdout)
    if returncode == TIMEOUT or timed_out(payload):
        return TIMEOUT, payload
    if returncode != 0:
        return USAGE_OR_TRANSPORT, payload
    if payload is None:
        return EMPTY, payload
    return (MESSAGES if rows_of(payload) else EMPTY), payload


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
        for row in rows_of(payload):
            kind = row.get("type") or ("question" if row.get("subject") else "unknown")
            print(f"{kind}\t{json.dumps(row, ensure_ascii=False)}")
    return MESSAGES


if __name__ == "__main__":
    raise SystemExit(main())
