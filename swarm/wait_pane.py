"""Wait for another pane's turn to end, in one blocking call, only when the turn is proven.

Why: "tell me when that pane finished its turn" had no callable form either, so a session slept and
read the peer's screen. The screen is not evidence - an idle-looking pane may never have started -
so the wait here is gated on a *strong* receipt and never on an observation.

Two phases, and the first one is the whole point:

* A, turn evidence (required): the receipt of `terminal send --wait-submit`, which separates
  `input_accepted` from `turn_started`. `stages` must contain `turn_started`, the receipt must
  carry a `requestId`, and its `processIncarnation` must equal the *target terminal's* current
  `ptyId:incarnationId` (read with one `terminal show`, which is an identity lookup, not progress).
  Anything else - no file, no `turn_started`, another terminal, a replaced process - exits 4
  `unverifiable`. That is the honest answer, not a degradation: some providers answer
  `provider: "unsupported"` and never emit `turn_started`, and treating their `tui-idle` as a
  completed turn is exactly the sleep-then-look false positive this replaces.
* B, turn end (one call): `terminal wait --for tui-idle`, re-entered by the caller rather than
  asked for longer than 300 s. Timeout is 124; a `blockedReason` is 5 (`interaction_required`) and
  reports only the reason enum, never the screen.

`tui-idle` is a *scheduling* primitive, not an acceptance one. Exit 0 means "the turn this receipt
started has reached its boundary": the products still have to be verified before acting (I1), and
in-scope waits that are not peer handoffs - a human decision, an external job, a gate, a local
process exit - are not this tool's business.

The tool sends no input, acknowledges nothing, and writes no file (I7): it calls `terminal show`,
then `terminal wait`, and prints one line. Nothing here grants authority over the peer.

Exit status: 0 turn ended, 4 unverifiable (no turn evidence), 5 interaction required,
124 timeout, 2 usage or transport failure.

Standard library only, like the rest of this directory.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

from terminal_idle_wait import (BLOCKED_REASONS, MAX_NATIVE_WAIT_MS, idle_wait_args,
                                min_rpc_timeout_seconds)

TURN_ENDED = 0
USAGE_OR_TRANSPORT = 2
UNVERIFIABLE = 4
INTERACTION_REQUIRED = 5
TIMEOUT = 124
DEFAULT_IDLE_TIMEOUT_SECONDS = MAX_NATIVE_WAIT_MS // 1000
MAX_IDLE_TIMEOUT_SECONDS = MAX_NATIVE_WAIT_MS // 1000
# `terminal show` is one quick read, not a wait: its budget must not be the peer's wait budget.
SHOW_TIMEOUT_SECONDS = 20


class Unverifiable(Exception):
    """The turn boundary cannot be proven from what we were given. Only exit 4 is allowed."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def parse(text: str):
    """The CLI's JSON, pretty-printed or one line; None when it is not JSON at all."""
    text = (text or "").strip()
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


def unwrapped(payload):
    """The `result` body of the CLI envelope, or the payload itself when it is already one."""
    if isinstance(payload, dict) and isinstance(payload.get("result"), dict):
        return payload["result"]
    return payload


def prompt_receipt(payload, terminal: str):
    """(requestId, processIncarnation) of a `--wait-submit` receipt, or Unverifiable.

    Why this shape and not "the pane looks busy": the receipt is the only thing that ties the state
    we are waiting on to *this* input. A stage list without `turn_started`, a receipt without a
    request id, or a receipt naming another terminal proves nothing, so each is its own reason.
    """
    if not isinstance(payload, dict):
        raise Unverifiable("turn_evidence_unreadable")
    if payload.get("ok") is False:
        raise Unverifiable("turn_evidence_not_ok")
    body = unwrapped(payload)
    send = body.get("send") if isinstance(body, dict) else None
    if not isinstance(send, dict):
        raise Unverifiable("turn_evidence_shape")
    if send.get("accepted") is not True:
        raise Unverifiable("turn_evidence_not_accepted")
    prompt = send.get("prompt")
    if not isinstance(prompt, dict):
        raise Unverifiable("turn_evidence_shape")
    stages = prompt.get("stages")
    if (not isinstance(stages, list) or not all(isinstance(stage, str) for stage in stages)
            or "turn_started" not in stages):
        raise Unverifiable("turn_not_started")
    request_id = prompt.get("requestId")
    if not isinstance(request_id, str) or not request_id:
        raise Unverifiable("turn_evidence_request_missing")
    for source in (prompt, send):
        named = source.get("terminalHandle")
        if named is not None and named != terminal:
            raise Unverifiable("turn_evidence_other_terminal")
    incarnation = prompt.get("processIncarnation", send.get("processIncarnation"))
    if not isinstance(incarnation, str) or not incarnation:
        raise Unverifiable("turn_evidence_incarnation_missing")
    return request_id, incarnation


def terminal_identity(payload, terminal: str):
    """`ptyId:incarnationId` of the target terminal right now, or Unverifiable."""
    body = unwrapped(payload)
    shown = body.get("terminal") if isinstance(body, dict) else None
    if not isinstance(shown, dict):
        raise Unverifiable("terminal_unreadable")
    if shown.get("handle") != terminal:
        raise Unverifiable("terminal_handle_mismatch")
    pty = shown.get("ptyId")
    incarnation = shown.get("incarnationId")
    if not all(isinstance(value, str) and value for value in (pty, incarnation)):
        raise Unverifiable("terminal_incarnation_unreadable")
    return f"{pty}:{incarnation}"


def wait_outcome(returncode: int, stdout: str, terminal: str):
    """(status, reason) for one `terminal wait --for tui-idle` result.

    A timeout is not a failed RPC: the CLI answers it with its own error envelope, and the caller
    may re-enter another bounded window. Anything that cannot be decoded is a transport result -
    it is not a claim about the peer.
    """
    if returncode == TIMEOUT:
        return TIMEOUT, None
    if returncode is not None and returncode < 0:
        return USAGE_OR_TRANSPORT, None
    payload = parse(stdout)
    if not isinstance(payload, dict):
        return USAGE_OR_TRANSPORT, None
    if payload.get("ok") is False:
        error = payload.get("error")
        code = error.get("code") if isinstance(error, dict) else None
        if code == "timeout" and returncode == 1:
            return TIMEOUT, None
        return USAGE_OR_TRANSPORT, None
    body = unwrapped(payload)
    wait = body.get("wait") if isinstance(body, dict) else None
    if not isinstance(wait, dict):
        return USAGE_OR_TRANSPORT, None
    if wait.get("handle") != terminal or wait.get("condition") != "tui-idle":
        return USAGE_OR_TRANSPORT, None
    satisfied = wait.get("satisfied")
    if satisfied is True:
        return TURN_ENDED, None
    if satisfied is not False:
        return USAGE_OR_TRANSPORT, None
    reason = wait.get("blockedReason")
    if isinstance(reason, str) and reason in BLOCKED_REASONS:
        return INTERACTION_REQUIRED, reason
    return USAGE_OR_TRANSPORT, None


def run(cli: str, args: list[str], timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run([cli, *args, "--json"], capture_output=True, text=True, timeout=timeout)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Wait for a peer pane's turn to end: proven turn evidence, then one bounded "
                    "`terminal wait --for tui-idle`.",
        epilog="Exit: 0 turn ended, 4 unverifiable (no turn evidence), 5 interaction required, "
               "124 timeout, 2 usage/transport. A wake is not a receipt: verify the products. "
               "This never sends input, never acknowledges and never writes a file.")
    parser.add_argument("--terminal", required=True, help="the peer pane whose turn to wait for")
    parser.add_argument("--turn-evidence",
                        help="saved receipt of `terminal send --wait-submit` (required to prove the turn)")
    parser.add_argument("--idle-timeout", type=int, default=DEFAULT_IDLE_TIMEOUT_SECONDS,
                        help=f"seconds for the one native wait, at most {MAX_IDLE_TIMEOUT_SECONDS}; "
                             "re-enter rather than asking for a longer window")
    parser.add_argument("--cli", default="orca", help="executable to call (default: orca)")
    parser.add_argument("--json", action="store_true",
                        help="print the receipt as one JSON line (default: one word)")
    args = parser.parse_args(argv)
    if not 0 < args.idle_timeout <= MAX_IDLE_TIMEOUT_SECONDS:
        parser.error(f"--idle-timeout must be in 1..{MAX_IDLE_TIMEOUT_SECONDS}")
    wait_ms = args.idle_timeout * 1000
    budget = min_rpc_timeout_seconds(wait_ms)

    # Phase A. Nothing about the peer is read or waited on before the turn is proven.
    try:
        if not args.turn_evidence:
            raise Unverifiable("turn_evidence_required")
        try:
            text = Path(args.turn_evidence).read_text()
        except OSError:
            raise Unverifiable("turn_evidence_unreadable") from None
        request_id, incarnation = prompt_receipt(parse(text), args.terminal)
        try:
            shown = run(args.cli, ["terminal", "show", "--terminal", args.terminal],
                        min(budget, SHOW_TIMEOUT_SECONDS))
        except subprocess.TimeoutExpired:
            print("transport: the terminal identity read did not answer", file=sys.stderr)
            return USAGE_OR_TRANSPORT
        if shown.returncode != 0:
            print("terminal show failed; the peer cannot be identified", file=sys.stderr)
            return USAGE_OR_TRANSPORT
        current = terminal_identity(parse(shown.stdout), args.terminal)
        if current != incarnation:
            raise Unverifiable("turn_evidence_incarnation_mismatch")
    except Unverifiable as error:
        report = {"outcome": "unverifiable", "reason": error.reason}
        print(f"unverifiable: {error.reason}; do not wait on or act for this pane",
              file=sys.stderr)
        if args.json:
            print(json.dumps({"event": "wait_pane", **report}, ensure_ascii=False))
        else:
            print(report["outcome"])
        return UNVERIFIABLE

    # Phase B. One bounded native wait; the caller re-enters instead of asking for longer.
    try:
        completed = run(args.cli, idle_wait_args(args.terminal, wait_ms), budget)
    except subprocess.TimeoutExpired:
        print(f"transport: no receipt within {budget} s; the wait did not report", file=sys.stderr)
        return USAGE_OR_TRANSPORT
    status, reason = wait_outcome(completed.returncode, completed.stdout, args.terminal)
    if status == TIMEOUT:
        print("timeout: the turn has not ended within the window; re-enter, do not act",
              file=sys.stderr)
        return TIMEOUT
    if status == INTERACTION_REQUIRED:
        print(f"interaction required: {reason}", file=sys.stderr)
        if args.json:
            print(json.dumps({"event": "wait_pane", "outcome": "interaction_required",
                              "reason": reason}, ensure_ascii=False))
        else:
            print("interaction_required")
        return INTERACTION_REQUIRED
    if status != TURN_ENDED:
        print(f"wait failed with exit {completed.returncode}; receipt not understood",
              file=sys.stderr)
        return USAGE_OR_TRANSPORT
    outcome = {"event": "wait_pane", "outcome": "turn_ended", "request_id": request_id,
               "idle_ms": wait_ms}
    if args.json:
        print(json.dumps(outcome, ensure_ascii=False))
    else:
        print("turn_ended")
    return TURN_ENDED


if __name__ == "__main__":
    raise SystemExit(main())
