"""Wait for another pane's turn to end, in one blocking call, only when the turn is proven.

Why: "tell me when that pane finished its turn" had no callable form either, so a session slept and
read the peer's screen. The screen is not evidence - an idle-looking pane may never have started -
so the wait here is gated on a *strong* receipt and never on an observation.

Two phases, and the first one is the whole point:

* A, turn evidence (required): the receipt of `terminal send --wait-submit`, which separates
  `input_accepted` from `turn_started`. `stages` must contain `turn_started`, the receipt must
  carry a `requestId`, and it must bind to the *target terminal*: one `terminal show` (an identity
  lookup, not a progress probe) supplies `ptyId` and `incarnationId`, and the receipt's
  `processIncarnation` must name that same live process **in either spelling the runtime uses** -
  the bare `incarnationId` that `terminal send` receipts carry, or the composed
  `ptyId:incarnationId` that orchestration records carry. A receipt that names no pane at all and
  only carries the bare id proves nothing about *which* pane it came from, so that is `unbound`.
  Anything else - no file, no `turn_started`, another terminal, an unbound or replaced process -
  exits 4 `unverifiable`. That is the honest answer, not a degradation: some providers answer
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


def receipt_handle(send, prompt):
    """The pane handle the receipt itself names, or None.

    Why both places: `terminal send` writes `handle` on the `send` object, while the prompt-delivery
    shape carries `terminalHandle` inside `prompt` (and older producers put it on `send`). Reading
    only one of them left this check vacuous against the real receipt, which names the pane on
    `send.handle` and nowhere else.
    """
    for source in (prompt, send):
        handle = source.get("terminalHandle")
        if isinstance(handle, str) and handle:
            return handle
    handle = send.get("handle")
    return handle if isinstance(handle, str) and handle else None


def prompt_receipt(payload, terminal: str):
    """(requestId, processIncarnation, names_this_pane) of a `--wait-submit` receipt.

    Why this shape and not "the pane looks busy": the receipt is the only thing that ties the state
    we are waiting on to *this* input. A stage list without `turn_started`, a receipt without a
    request id, or a receipt naming another terminal proves nothing, so each is its own reason.
    `names_this_pane` is False when the receipt carries no pane handle at all; the caller decides
    whether the incarnation spelling alone is enough (a composed `ptyId:incarnationId` is, a bare
    `incarnationId` is not).
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
    named = receipt_handle(send, prompt)
    if named is not None and named != terminal:
        raise Unverifiable("turn_evidence_other_terminal")
    incarnation = prompt.get("processIncarnation", send.get("processIncarnation"))
    if not isinstance(incarnation, str) or not incarnation:
        raise Unverifiable("turn_evidence_incarnation_missing")
    return request_id, incarnation, named == terminal


def terminal_identity(payload, terminal: str):
    """(ptyId, incarnationId) of the target terminal right now, or Unverifiable.

    Two parts, not one composed string: the receipt may name the process with either the bare
    `incarnationId` or `ptyId:incarnationId`, so the comparison has to be able to see both fields
    instead of rebuilding one canonical spelling and comparing that.
    """
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
    return pty, incarnation


def incarnation_matches(value: str, pty: str, incarnation: str) -> bool:
    """Whether a receipt's `processIncarnation` names this pane's live process.

    The runtime produces the same field in two spellings: `terminal send` receipts carry the bare
    `incarnationId`, orchestration records carry `ptyId:incarnationId`, and a pty without an
    incarnation id falls back to `runtimeId:ptyId:generation`. Only the first two can be checked
    against what `terminal show` reports; the degraded form stays unmatched on purpose, because
    accepting a generation number as an incarnation is the fail-open case this gate exists to stop.
    """
    return value == incarnation or value == f"{pty}:{incarnation}"


def wait_outcome(returncode: int, stdout: str, terminal: str):
    """(status, reason) for one `terminal wait --for tui-idle` result.

    A timeout is not a failed RPC: the CLI answers it with its own error envelope, and the caller
    may re-enter another bounded window. Anything that cannot be decoded is a transport result -
    it is not a claim about the peer.

    The success shape is copied from `terminal_idle_wait.decode_idle_wait`, because a decoded
    `satisfied: true` on its own says only "the TUI was idle". The turn boundary this tool reports
    is meaningful only for the *same live process*, so the exit code must agree (0), the terminal
    must still be `running`, `exitCode` must be absent and `exitCause` unset. An exited pane that
    the runtime also calls idle is a dead peer, not a finished turn - reporting it as one would
    turn "the process is gone" into "your turn ended", which is exactly the fail-open case I6
    forbids.
    """
    if returncode == TIMEOUT:
        return TIMEOUT, None
    if type(returncode) is not int or returncode < 0:
        return USAGE_OR_TRANSPORT, None
    payload = parse(stdout)
    if not isinstance(payload, dict) or type(payload.get("ok")) is not bool:
        return USAGE_OR_TRANSPORT, None
    if payload["ok"] is False:
        error = payload.get("error")
        code = error.get("code") if isinstance(error, dict) else None
        # The CLI's native timeout: exit 1, `error.code == "timeout"`, no result body.
        if returncode == 1 and code == "timeout" and "result" not in payload:
            return TIMEOUT, None
        return USAGE_OR_TRANSPORT, None
    if "error" in payload:
        return USAGE_OR_TRANSPORT, None
    body = payload.get("result")
    if not isinstance(body, dict):
        return USAGE_OR_TRANSPORT, None
    wait = body.get("wait")
    if not isinstance(wait, dict):
        return USAGE_OR_TRANSPORT, None
    if wait.get("handle") != terminal or wait.get("condition") != "tui-idle":
        return USAGE_OR_TRANSPORT, None
    satisfied = wait.get("satisfied")
    status = wait.get("status")
    if type(satisfied) is not bool or status not in ("running", "exited", "unknown"):
        return USAGE_OR_TRANSPORT, None
    if "exitCode" not in wait or not (wait["exitCode"] is None or type(wait["exitCode"]) is int):
        return USAGE_OR_TRANSPORT, None
    # Same live process, or nothing here is reportable as a turn boundary.
    if status != "running" or wait["exitCode"] is not None or wait.get("exitCause") is not None:
        return USAGE_OR_TRANSPORT, None
    if satisfied is True:
        if returncode != 0 or "blockedReason" in wait:
            return USAGE_OR_TRANSPORT, None
        return TURN_ENDED, None
    reason = wait.get("blockedReason")
    if returncode == 1 and isinstance(reason, str) and reason in BLOCKED_REASONS:
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
                        help="saved receipt of `terminal send --wait-submit` (required to prove the "
                             "turn: it must name this pane and its live process, in either the bare "
                             "incarnationId or the ptyId:incarnationId spelling)")
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
        request_id, incarnation, names_pane = prompt_receipt(parse(text), args.terminal)
        try:
            shown = run(args.cli, ["terminal", "show", "--terminal", args.terminal],
                        min(budget, SHOW_TIMEOUT_SECONDS))
        except subprocess.TimeoutExpired:
            print("transport: the terminal identity read did not answer", file=sys.stderr)
            return USAGE_OR_TRANSPORT
        if shown.returncode != 0:
            print("terminal show failed; the peer cannot be identified", file=sys.stderr)
            return USAGE_OR_TRANSPORT
        pty, live_incarnation = terminal_identity(parse(shown.stdout), args.terminal)
        if not incarnation_matches(incarnation, pty, live_incarnation):
            raise Unverifiable("turn_evidence_incarnation_mismatch")
        # A bare incarnation id is not pane-bound on its own: any pane's receipt could carry one.
        # The composed spelling embeds the ptyId, so it binds even when the receipt names no handle.
        if not names_pane and incarnation == live_incarnation:
            raise Unverifiable("turn_evidence_unbound")
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
    outcome = {"event": "wait_pane", "outcome": "turn_ended", "request_id": request_id}
    if args.json:
        print(json.dumps(outcome, ensure_ascii=False))
    else:
        print("turn_ended")
    return TURN_ENDED


if __name__ == "__main__":
    raise SystemExit(main())
