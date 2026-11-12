"""Wait for one fixed bootstrap stage, with the caller's deadline in charge.

Why: the protocol names four fixed markers, and the only allowed way to wait for one used to be
"assemble the path yourself, then poll it" — which is how a caller ends up writing
`for i in $(seq 1 N); do sleep 8; ...; done` and reading a slow stage as a dead one. The stage ->
path mapping already exists in `bootstrap_protocol.layout()`; this module is the missing entry that
uses it, so nobody has to copy it.

What this is: a **waiting** channel. What it is not:

* It does not connect to the attempt owner, take a lock, read `owner.json` or write any slot.
* Exit 0 is not `confirmed`. A slot that needs confirmation still needs the owner query, and a
  stage that needs a role's judgement still stops at `needs_role_judgement`.
* The evidence Ref printed at 0 was read by this tool; the caller must carry that exact
  `{path, sha256}` forward instead of computing its own — and must do so even when the stage was
  already satisfied. `already_satisfied` is about the window, not about the obligation.

Why "present but unparsable" is a failure and never a retry: a registered attempt's fixed slots are
published by the owner through `publish_new` (`os.link`), so a visible path always carries complete
bytes. A path that is there and does not validate is a real defect (a gap, a consumed mismatch, a
time-order violation), and re-reading it cannot fix it. There is also no exit 3: "the stage was
already passed" and "the stage just arrived" are one result with two flavours, because two exit
codes for one state make the caller branch into two sets of handling.

Exit status is the classification, like `wait_for_file.py` and `wait_for_events.py`:
0 validated (or already satisfied), 124 deadline, 4 attempt/binding unreachable,
5 present but unvalidated, 2 usage/transport/pin-or-binding mismatch.
`wait_for_file` knows 0/124/4/2 only; 5 is this tool's own answer.

Standard library only, like the rest of this directory.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time

import wait_for_file
from bootstrap_events import BootstrapError, EvidenceReader, _check, binding as read_binding
from bootstrap_protocol import EVENTS, stage_path
from coordinator_io import FilePinChanged, now, path, timestamp

VALIDATED = 0
USAGE_OR_REFUSED = 2
UNREACHABLE = 4
PRESENT_UNVALIDATED = 5
TIMEOUT = 124
# One call, not one wait (I4): a longer wait re-enters this tool instead of raising this number.
MAX_TIMEOUT_MS = 300_000
DEFAULT_TIMEOUT_MS = 300_000


def _payload(exit_code, stage, outcome, *, reason=None, state=None, already_satisfied=None,
             validated_count=None, ref=None, elapsed_ms=None, detail=None):
    """One shape for every answer, so a caller cannot mistake one case for another.

    `already_satisfied`/`validated_count` are **only** for exit 0: they distinguish "it was already
    there" from "it just arrived", which is a property of a success. A failure carries its reason
    and state and nothing else — a chain length attached to a 124 would read as progress a caller
    could carry forward, and it is not (design §3.2.2). Diagnosis of "how far did it get" belongs
    to `strict-bootstrap-state --check`, which says what it is: a read-only diagnostic.
    """
    body = {"event": "wait_stage", "ok": exit_code == VALIDATED, "stage": stage,
            "outcome": outcome, "exit": exit_code, "execution_authorized": False}
    if reason is not None:
        body["reason"] = reason
    if state is not None:
        body["state"] = state
    if already_satisfied is not None:
        body["already_satisfied"] = already_satisfied
    if validated_count is not None:
        body["validated_count"] = validated_count
    if ref is not None:
        body["ref"] = ref
    if elapsed_ms is not None:
        body["elapsed_ms"] = elapsed_ms
    if detail is not None:
        # Diagnostics only: a reason token, never a payload or a path (I5).
        body["diagnostics"] = detail
    return body


def _unwaitable(target):
    """A reason this marker can never appear, or None.

    Deliberately not `wait_for_file.precondition`: that answers "is the parent reachable", and for
    a stage marker the parent is `events/`, which legitimately does not exist until the owner
    publishes the first marker. Answering 4 there would refuse to wait for stage 1 — the very first
    wait in the protocol. A missing parent is therefore a wait, not a refusal; `publication_wait`
    degrades to its fallback period inside this one bounded call.
    """
    parent = Path(target).parent
    if parent.exists() and not parent.is_dir():
        return "stage_parent_not_a_directory"
    if parent.is_dir() and not os.access(parent, os.R_OK | os.X_OK):
        return "stage_parent_unreadable"
    return None


def _binding_or_refusal(root, binding_sha256, expect_attempt):
    """(binding, None) or (None, (code, reason, state, detail)).

    Binding-level failures are exit 2 (a caller's pin/attempt/layout argument is wrong) except a
    missing binding, which is exit 4: a deadline cannot make a file appear.
    """
    try:
        _, value = read_binding(EvidenceReader(), root, binding_sha256, expect_attempt)
        return value, None
    except FileNotFoundError:
        # A missing binding and a missing pinned input are different defects that used to share one
        # token: the binding was present while the workspace/skill it pins had been removed, and the
        # receipt blamed the binding (live finding). Say which file is actually gone.
        gone = ("attempt_binding" if not (root / "attempt-binding.json").exists()
                else "pinned_input")
        return None, (UNREACHABLE, "bootstrap_wait_stage_unreachable", None, {gone: "missing"})
    except FilePinChanged:
        return None, (USAGE_OR_REFUSED, "file_pin_changed", "blocked_stale_or_mismatch", None)
    except BootstrapError as exc:
        return None, (USAGE_OR_REFUSED, str(exc), exc.state, None)
    except PermissionError:
        return None, (USAGE_OR_REFUSED, "evidence_access_denied", "blocked_permission_denied",
                      None)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError):
        return None, (USAGE_OR_REFUSED, "invalid_or_unreadable_evidence",
                      "blocked_invalid_marker", None)


def _validated(reader, root, binding_sha256, expect_attempt, clock):
    """One read-only pass of the chain: (validated_count, error).

    `error` is a (reason, state) pair when the chain itself does not validate. The caller's reader
    is passed in so the refs it actually read are available: the evidence Ref must come from bytes
    this tool read, not from a second hashing pass.
    """
    result = {}
    try:
        _check(root, binding_sha256, expect_attempt, clock, result, reader=reader)
    except FilePinChanged:
        return 0, ("file_pin_changed", "blocked_stale_or_mismatch")
    except BootstrapError as exc:
        return 0, (str(exc), exc.state)
    except PermissionError:
        return 0, ("evidence_access_denied", "blocked_permission_denied")
    except FileNotFoundError:
        return 0, ("binding_or_committed_reference_missing", "blocked_invalid_marker")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError):
        return 0, ("invalid_or_unreadable_evidence", "blocked_invalid_marker")
    return len(result.get("validated_markers", [])), None


def wait_stage(*, bootstrap, expect_attempt, binding_sha256, stage, timeout_ms=DEFAULT_TIMEOUT_MS,
               clock=None, waiter=None, monotonic=None):
    """Wait for one stage marker, then validate. Returns the payload; `payload["exit"]` is the status.

    `waiter` and `monotonic` are injectable so tests can drive every outcome without sleeping.
    """
    waiter = wait_for_file.wait if waiter is None else waiter
    monotonic = time.monotonic if monotonic is None else monotonic
    clock = timestamp(now()) if clock is None else clock
    if type(stage) is not int or not 1 <= stage <= len(EVENTS):
        return _payload(USAGE_OR_REFUSED, stage if type(stage) is int else None, "refused",
                        reason="bootstrap_wait_stage_invalid")
    if type(timeout_ms) is not int or not 0 < timeout_ms <= MAX_TIMEOUT_MS:
        return _payload(USAGE_OR_REFUSED, stage, "refused", reason="bootstrap_wait_stage_invalid")

    started = monotonic()
    try:
        root = path(bootstrap, directory=True)
    except (OSError, ValueError, KeyError, TypeError):
        return _payload(UNREACHABLE, stage, "unreachable", reason="bootstrap_wait_stage_unreachable",
                        detail={"attempt_directory": "unreachable"})
    value, refusal = _binding_or_refusal(root, binding_sha256, expect_attempt)
    if refusal is not None:
        code, reason, state, detail = refusal
        return _payload(code, stage, "unreachable" if code == UNREACHABLE else "refused",
                        reason=reason, state=state, detail=detail)

    target = stage_path(value, stage)
    reader = EvidenceReader()
    count, error = _validated(reader, root, binding_sha256, expect_attempt, clock)
    if error is not None:
        reason, state = error
        code = USAGE_OR_REFUSED if reason == "file_pin_changed" else PRESENT_UNVALIDATED
        return _payload(code, stage, "present_unvalidated", reason=reason, state=state)
    if count >= stage:
        return _payload(VALIDATED, stage, "validated", already_satisfied=True,
                        validated_count=count, ref=reader.refs[target],
                        elapsed_ms=int((monotonic() - started) * 1000))

    problem = _unwaitable(target)
    if problem is not None:
        return _payload(UNREACHABLE, stage, "unreachable", reason="bootstrap_wait_stage_unreachable",
                        detail={"stage_path": problem})
    status, _counters = waiter(target, "appear", timeout_ms)
    if status == wait_for_file.TIMEOUT:
        return _payload(TIMEOUT, stage, "timeout", reason="bootstrap_wait_stage_timeout",
                        elapsed_ms=int((monotonic() - started) * 1000))

    reader = EvidenceReader()
    count, error = _validated(reader, root, binding_sha256, expect_attempt, clock)
    if error is not None:
        reason, state = error
        code = USAGE_OR_REFUSED if reason == "file_pin_changed" else PRESENT_UNVALIDATED
        return _payload(code, stage, "present_unvalidated", reason=reason, state=state,
                        elapsed_ms=int((monotonic() - started) * 1000))
    if count < stage:
        # The path appeared but the chain still stops short: a real defect, not a slow writer.
        return _payload(PRESENT_UNVALIDATED, stage, "present_unvalidated",
                        reason="bootstrap_wait_stage_present_unvalidated",
                        elapsed_ms=int((monotonic() - started) * 1000))
    return _payload(VALIDATED, stage, "validated", already_satisfied=False, validated_count=count,
                    ref=reader.refs[target], elapsed_ms=int((monotonic() - started) * 1000))


def cli_main(argv=None):
    parser = argparse.ArgumentParser(
        description="Wait for one fixed bootstrap stage marker, bounded by one deadline.",
        epilog="Exit: 0 validated, 124 timeout, 4 attempt/binding unreachable, "
               "5 present but unvalidated, 2 usage/pin/transport. Not confirmation, not progress.")
    parser.add_argument("--bootstrap", required=True, help="the attempt's bootstrap directory")
    parser.add_argument("--expect-attempt", required=True)
    parser.add_argument("--attempt-binding-sha256", required=True)
    parser.add_argument("--stage", type=int, required=True,
                        help=f"marker stage 1..{len(EVENTS)}; stage 0 is the binding itself and is "
                             "refused")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS,
                        help=f"the whole budget, at most {MAX_TIMEOUT_MS}; re-enter instead of "
                             "asking for a longer window")
    parser.add_argument("--json", action="store_true", help="print the receipt as one JSON line")
    args = parser.parse_args(argv)
    if not 1 <= args.stage <= len(EVENTS):
        parser.error(f"--stage must be in 1..{len(EVENTS)}")
    if not 0 < args.timeout_ms <= MAX_TIMEOUT_MS:
        parser.error(f"--timeout-ms must be in 1..{MAX_TIMEOUT_MS}")

    payload = wait_stage(bootstrap=args.bootstrap, expect_attempt=args.expect_attempt,
                         binding_sha256=args.attempt_binding_sha256, stage=args.stage,
                         timeout_ms=args.timeout_ms)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(payload["outcome"])
    if payload["exit"] != VALIDATED:
        print(f"{payload['outcome']}: {payload.get('reason', 'unknown')}; do not act",
              file=sys.stderr)
    return payload["exit"]


if __name__ == "__main__":
    raise SystemExit(cli_main())
