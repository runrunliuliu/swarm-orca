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

A timeout is not only the exit-124 shape: this runtime answers an elapsed `check --wait` with
`ok: true`, `count: 0`, **no** `timedOut` key and exit 0 (measured 2026-11-12), which used to be
classified as an empty batch. That collapse made "waited the whole window and nothing came"
indistinguishable from "a batch was delivered empty", and any caller that re-enters on the
second case is reasoning about the wrong event. So the wrapper measures its own elapsed monotonic
time and treats a complete, empty receipt that spent the window as the timeout it is.

The inference is deliberately narrow, because a wrong `124` is worse than a missed one:

* only when the receipt is complete (`ok: true`, an explicit empty `messages` list, `count: 0`)
  **and** carries no `timedOut`/`timeout` key - an explicit `false` is the CLI stating "not
  timed out" and always wins over the elapsed guess;
* only within `TOLERANCE_MS` of the window, and only in the "budget is spent" direction, so an
  early empty batch stays an empty batch;
* never for a signal-killed child, a non-zero exit, or a truncated/half-written JSON receipt.

Because the guess reads the wrapper's own clock, the caller's outer deadline must exceed
`--timeout-ms`; otherwise the receipt never arrives and nothing can be classified.

Standard library only, like the rest of this directory.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time

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

# How far before the requested window an empty receipt may come back and still be "spent".
# Sub-second slack only: timers and socket teardown round, but a CLI that answered early said
# something real about an empty batch, and 200 ms is not enough time for it to be wrong about a
# window it was also given.
TOLERANCE_MS = 200


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


def timed_out_by_elapsed(payload, elapsed_ms: float | None, timeout_ms: int | None) -> bool:
    """A complete receipt that states "no messages" after spending the window is a timeout.

    Why the shape check comes first: only this runtime's own timeout answer is safe to infer.
    A half-parsed receipt, an unrecognised body or an explicit `timedOut: false` all mean "not
    knowable from elapsed time", and guessing 124 there would replace "no messages" with a
    failure the caller would retry.
    """
    if elapsed_ms is None or timeout_ms is None:
        return False
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        return False
    body = unwrap(payload)
    if not isinstance(body, dict):
        return False
    if any(key in body for key in TIMEOUT_KEYS):
        return False
    if body.get("messages") != [] or body.get("count") != 0:
        return False
    return elapsed_ms >= timeout_ms - TOLERANCE_MS


def classify(returncode: int, stdout: str, *, elapsed_ms: float | None = None,
             timeout_ms: int | None = None) -> tuple[int, dict | list | None]:
    """Map one CLI result to a status. A timeout in the receipt outranks the exit code.

    `elapsed_ms`/`timeout_ms` are the wrapper's own measurement of the call it just made; pass
    them and a spent window with an empty receipt classifies as TIMEOUT. Omitting them keeps the
    old exit-code/`timedOut`-only behaviour.
    """
    payload = parse(stdout)
    if returncode == TIMEOUT or timed_out(payload):
        return TIMEOUT, payload
    if returncode != 0:
        # A signal-killed or failed CLI is a transport result, never a timeout guess: the child
        # did not get to answer, so its elapsed time says nothing about the wait.
        return USAGE_OR_TRANSPORT, payload
    if payload is None:
        return EMPTY, payload
    if not rows_of(payload) and timed_out_by_elapsed(payload, elapsed_ms, timeout_ms):
        return TIMEOUT, payload
    return (MESSAGES if rows_of(payload) else EMPTY), payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", default="orca", help="executable to call (default: orca)")
    parser.add_argument("--types", default=DEFAULT_TYPES, help="what wakes the call, not a filter")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS,
                        help="one bounded call; re-enter instead of asking for a longer window "
                             "(the caller's own deadline must exceed this, or the receipt never arrives)")
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
    started = time.monotonic()
    completed = subprocess.run(command, capture_output=True, text=True)
    elapsed_ms = (time.monotonic() - started) * 1000
    # Why stderr is only forwarded on failure: it is keepalive plus diagnostics, and the caller's
    # message stream must stay parseable.
    status, payload = classify(completed.returncode, completed.stdout, elapsed_ms=elapsed_ms,
                               timeout_ms=args.timeout_ms)
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
