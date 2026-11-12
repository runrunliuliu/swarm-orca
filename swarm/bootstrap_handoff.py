"""Accept a strict bootstrap handoff delivered as a mailbox message, with two independent assertions.

Why: the live attempt that produced this module had correct pins and correct bytes, and the
handoff still arrived from the wrong pane. The pins were checked; the sender was not, because
nothing compared `from_handle` with the `operator.terminal` the attempt pinned. So the acceptance
here makes two assertions and never lets one stand in for the other:

* **A, bytes**: every `refs` entry in the envelope pins the bytes actually on disk
  (`handoff_pin_mismatch` when it does not).
* **B, sender**: the delivery row's `from_handle` equals `binding.operator.terminal`
  (`handoff_sender_mismatch`), and a missing or `unknown` handle is `handoff_sender_unanchored`.

B is a **consistency check: it stops a mis-fill and an accident, not impersonation.** The CLI
resolves `--from` (flag, injected agent session address, `ORCA_TERMINAL_HANDLE`, implicit sender),
but the runtime method only defaults a missing `params.from` to the literal `unknown`
(`orca/src/main/runtime/rpc/methods/orchestration/messaging/send-methods.ts`), and a plain PTY pane
may pass another pane's handle. Nothing here is a signature, and this module must not be described
as a security boundary. `sender_anchor: "binding-operator"` records which anchor was used, so a
reader can see it is the binding's own field rather than an independent fixed value.

What this is not: authorization, confirmation, progress, or a gate input. The acceptance record is
a local receipt written under `control/handoff/`, it carries `execution_authorized: false`, and no
validator, confirmation chain or startup gate reads it.

Waiting never consumes: the CLI call this module builds passes `--peek`, so a failure between
reading and recording leaves the message unread and readable again. A duplicate is therefore the
normal way a lost record is repaired, not a conflict — unless the same `handoff_id` arrives with
different bytes, which is a conflict the receiver must not arbitrate.

Exit status: 0 accepted, 3 nothing to do (empty batch / no row for this attempt / identical
duplicate), 5 refused (both assertions, payload shape, duplicate conflict, record conflict),
2 usage, transport, or the record could not be written at all, 4 the attempt is unreachable,
124 the wait window expired. 124 is its own answer because an elapsed `check --wait` returns
`ok:true, count:0` with exit 0 on this runtime (measured), so "no messages" and "spent the window"
must be told apart by shape plus this tool's own monotonic clock, never by the exit code.

Standard library only, like the rest of this directory.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from bootstrap_events import BootstrapError, EvidenceReader, binding as read_binding
from coordinator_io import (FilePinChanged, canonical, digest, now, path, pinned,
                            publish_new, timestamp, validate_ref)
from wait_for_events import (EMPTY, MESSAGES, TIMEOUT, USAGE_OR_TRANSPORT, classify, parse,
                             rows_of, unwrap)

ACCEPTED = 0
USAGE = 2
ABSENT = 3
UNREACHABLE = 4
REFUSED = 5
WAIT_TIMEOUT = 124

HANDOFF_TYPE = "handoff"
SENDER_ANCHOR = "binding-operator"
DEFAULT_TIMEOUT_MS = 300_000
MAX_TIMEOUT_MS = 300_000
# The envelope is the smallest set the acceptance decision depends on. `subject` is compared from
# the delivery row, not the envelope, because it is what the CLI itself carries.
ENVELOPE_FIELDS = ("schema_version", "handoff_id", "attempt_id", "refs", "payload_sha256")
# Compared against an existing acceptance record. These five, and nothing else, decide
# duplicate-vs-conflict: two deliveries claiming one `handoff_id` with different content mean the
# id was reused or the handoff was rewritten, and neither is the receiver's call to resolve.
COMPARED_FIELDS = ("payload_sha256", "refs", "from_handle", "subject", "sender_anchor")
# An id is used as a file name, so its shape is part of the contract: no separators, no dots.
HANDOFF_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{7,63}")


class Refusal(ValueError):
    """A typed refusal: `code` is the reason, `exit` the status, `state` the P0 outcome class."""

    def __init__(self, code, exit_code, state=None, **extra):
        super().__init__(code)
        self.code = code
        self.exit = exit_code
        self.state = state
        self.extra = extra


def _payload(exit_code, outcome, **body):
    result = {"event": "handoff_accept", "ok": exit_code == ACCEPTED, "outcome": outcome,
              "exit": exit_code, "execution_authorized": False, "sender_anchor": SENDER_ANCHOR}
    for key, value in body.items():
        if value is None:
            continue
        # `detail` is the refusal's diagnostics token set; escaping it as `diagnostics` keeps one
        # name across both tools in this family.
        result["diagnostics" if key == "detail" else key] = value
    return result


def record_path(root, handoff_id):
    """Where one accepted handoff's local receipt lives; the id's shape is enforced upstream."""
    if not isinstance(handoff_id, str) or not HANDOFF_ID.fullmatch(handoff_id):
        raise Refusal("handoff_payload_invalid", REFUSED)
    return Path(root) / "control" / "handoff" / (handoff_id + ".json")


def _directory(target):
    """Create `control/handoff/` at 0700, refusing anything that is not a plain directory.

    The receiver owns this directory, so an unexpected shape here (a symlink, a file) is not
    "somebody else's business": following it would write the receipt somewhere this attempt does
    not control.
    """
    target = Path(target)
    _guard(target)
    if not target.exists():
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(target, 0o700)
    return target


def _guard(target):
    """Refuse an unsafe record directory without creating or writing anything."""
    for candidate in (Path(target).parent, Path(target)):
        if candidate.is_symlink() or (candidate.exists() and not candidate.is_dir()):
            raise Refusal("handoff_record_dir_unsafe", REFUSED)
    return Path(target)


def envelope(row):
    """(envelope, None) or (None, Refusal): the smallest handoff payload, shape-checked.

    `payload_sha256` is the digest of the canonical envelope *without* itself, so the check is
    well-defined rather than circular.
    """
    raw = row.get("payload")
    if not isinstance(raw, str) or not raw.strip():
        raise Refusal("handoff_payload_invalid", REFUSED, detail={"field": "payload"})
    try:
        value = parse(raw.encode())
    except (ValueError, TypeError):
        raise Refusal("handoff_payload_invalid", REFUSED, detail={"field": "payload"}) from None
    if not isinstance(value, dict) or set(value) != set(ENVELOPE_FIELDS):
        raise Refusal("handoff_payload_invalid", REFUSED, detail={"field": "envelope_fields"})
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise Refusal("handoff_payload_invalid", REFUSED, detail={"field": "schema_version"})
    if not isinstance(value["handoff_id"], str) or not HANDOFF_ID.fullmatch(value["handoff_id"]):
        raise Refusal("handoff_payload_invalid", REFUSED, detail={"field": "handoff_id"})
    if not isinstance(value["attempt_id"], str) or not value["attempt_id"].strip():
        raise Refusal("handoff_payload_invalid", REFUSED, detail={"field": "attempt_id"})
    if not isinstance(value["refs"], list) or not value["refs"]:
        raise Refusal("handoff_payload_invalid", REFUSED, detail={"field": "refs"})
    for ref in value["refs"]:
        try:
            validate_ref(ref)
        except ValueError:
            raise Refusal("handoff_payload_invalid", REFUSED, detail={"field": "refs"}) from None
    expected = digest(canonical({key: value[key] for key in ENVELOPE_FIELDS
                                 if key != "payload_sha256"}))
    if value["payload_sha256"] != expected:
        raise Refusal("handoff_payload_invalid", REFUSED, detail={"field": "payload_sha256"})
    return value


def pin_error(value):
    """Assertion A: every envelope Ref must match the bytes on disk. None when they all do."""
    for ref in value["refs"]:
        try:
            pinned(ref)
        except (FilePinChanged, OSError, ValueError, KeyError, TypeError):
            return "handoff_pin_mismatch"
    return None


def sender_error(row, binding_value):
    """Assertion B: the delivery row's declared sender, against the operator the attempt pinned."""
    handle = row.get("from_handle")
    if not isinstance(handle, str) or not handle.strip() or handle == "unknown":
        return "handoff_sender_unanchored"
    if handle != binding_value["operator"]["terminal"]:
        return "handoff_sender_mismatch"
    return None


def _record_value(row, value, clock):
    created = row.get("created_at")
    subject = row.get("subject")
    if not isinstance(subject, str):
        raise Refusal("handoff_payload_invalid", REFUSED, detail={"field": "subject"})
    return {
        "schema_version": 1, "kind": "strict_handoff_acceptance",
        "handoff_id": value["handoff_id"], "attempt_id": value["attempt_id"],
        "msg_id": row.get("id"), "from_handle": row.get("from_handle"),
        "subject": subject, "payload_sha256": value["payload_sha256"], "refs": value["refs"],
        "sender_anchor": SENDER_ANCHOR,
        # A missing message timestamp stays unknown; it is never recorded as an empty zero.
        "created_at": created if isinstance(created, str) else None,
        "timestamp": "observed" if isinstance(created, str) else "unknown",
        "accepted_at": clock.isoformat(), "execution_authorized": False,
    }


def _read_record(target):
    """The existing acceptance record, or None. Never repaired, never rewritten."""
    try:
        raw = Path(target).read_bytes()
    except FileNotFoundError:
        return None
    except OSError:
        # Unreadable is not "absent": the caller must not treat it as free to overwrite.
        return {}
    try:
        return parse(raw)
    except (ValueError, TypeError):
        return {}


def _existing(target, value, row):
    """Duplicate vs conflict against an existing record: (exit_code, reason) or (None, None)."""
    recorded = _read_record(target)
    if recorded is None:
        return None, None
    candidate = {"payload_sha256": value["payload_sha256"], "refs": value["refs"],
                 "from_handle": row.get("from_handle"), "subject": row.get("subject"),
                 "sender_anchor": SENDER_ANCHOR}
    for field in COMPARED_FIELDS:
        if not isinstance(recorded, dict) or recorded.get(field) != candidate[field]:
            # Same id, different content: id reuse or a rewritten handoff. Not ours to arbitrate.
            return REFUSED, "handoff_duplicate_conflict"
    return ABSENT, "handoff_duplicate_no_effect"


def _commit_record(target, value):
    """Write the receipt, then classify by reading the bytes back (the P0 discipline).

    `publish_new` links complete temporary bytes onto the target, so a visible file is never a
    partial write. An error after the link is therefore classified by read-back rather than
    guessed: same bytes = admitted, absent = not admitted, different = needs reconciliation
    (never a second write). Returns `"duplicate"` when another claimant already linked that path.
    """
    raw = canonical(value) + b"\n"
    try:
        publish_new(Path(target), value)
    except FileExistsError:
        return "duplicate"
    except OSError:
        pass
    try:
        actual = Path(target).read_bytes()
    except FileNotFoundError:
        raise Refusal("handoff_record_unwritable", USAGE, state="not_admitted",
                      may_replay=True) from None
    except OSError:
        raise Refusal("handoff_record_conflict", REFUSED, state="needs_reconcile") from None
    if actual != raw:
        raise Refusal("handoff_record_conflict", REFUSED, state="needs_reconcile")
    return None


def _batch(receipt, runner_result):
    """(rows, None) or (None, Refusal) from one CLI answer or one captured receipt."""
    payload = receipt
    if runner_result is not None:
        returncode, stdout, elapsed_ms, timeout_ms = runner_result
        payload = parse(stdout)
        status, _ = classify(returncode, stdout, elapsed_ms=elapsed_ms, timeout_ms=timeout_ms)
        if payload is None and status in (MESSAGES, EMPTY):
            # A zero exit with unparsable stdout is not "no messages"; it is a receipt we cannot read.
            status = USAGE_OR_TRANSPORT
        if status == TIMEOUT:
            raise Refusal("handoff_wait_timeout", WAIT_TIMEOUT)
        if status == USAGE_OR_TRANSPORT:
            raise Refusal("handoff_delivery_unreadable", USAGE, state="not_admitted",
                          may_replay=True)
    if payload is None:
        raise Refusal("handoff_delivery_unreadable", USAGE, state="not_admitted", may_replay=True)
    # "Empty" must mean a complete receipt that says so, never a body this tool could not read:
    # treating a malformed `result` as "nothing to do" is exactly the silent-empty failure that
    # makes a caller re-enter a wait it should have reported.
    body = unwrap(payload)
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        raise Refusal("handoff_delivery_unreadable", USAGE, state="not_admitted", may_replay=True)
    rows = rows_of(payload)
    if not isinstance(rows, list):
        raise Refusal("handoff_delivery_unreadable", USAGE, state="not_admitted", may_replay=True)
    return rows


def _select(rows, expect_attempt):
    """(row, value) for this attempt, or a Refusal carrying the exit status."""
    handoffs = [row for row in rows if isinstance(row, dict) and row.get("type") == HANDOFF_TYPE]
    if not handoffs:
        raise Refusal("handoff_absent_no_effect", ABSENT)
    ours = []
    for row in handoffs:
        value = envelope(row)
        if value["attempt_id"] != expect_attempt:
            continue
        ours.append((row, value))
    if not ours:
        raise Refusal("handoff_absent_no_effect", ABSENT)
    if len({value["handoff_id"] for _, value in ours}) > 1:
        # Two different handoffs for one attempt in one batch: do not pick one.
        raise Refusal("handoff_duplicate_conflict", REFUSED)
    return ours[0]


def _check_argv(cli, types, timeout_ms):
    """The only wait shape this module uses: one bounded, non-consuming check.

    `--peek` is not optional. A consuming `check` marks the batch read, so a crash between reading
    and recording would lose the handoff with nothing to show for it; peeking leaves the message
    where a re-entry can find it, which is what makes the duplicate path the repair path.
    """
    return [cli, "orchestration", "check", "--peek", "--wait", "--types", types,
            "--timeout-ms", str(timeout_ms), "--json"]


def _invoke(argv):
    started = time.monotonic()
    completed = subprocess.run(argv, capture_output=True, text=True)
    return completed.returncode, completed.stdout


def accept_handoff(*, bootstrap, expect_attempt, binding_sha256, receipt=None,
                   wait=False, cli="orca", types=HANDOFF_TYPE, timeout_ms=DEFAULT_TIMEOUT_MS,
                   runner=None, clock=None, monotonic=None):
    """One acceptance decision. Returns the payload; `payload["exit"]` is the status."""
    runner = _invoke if runner is None else runner
    monotonic = time.monotonic if monotonic is None else monotonic
    clock = timestamp(now()) if clock is None else clock
    if receipt is not None and wait:
        return _payload(USAGE, "refused", reason="handoff_input_ambiguous")
    if receipt is None and not wait:
        return _payload(USAGE, "refused", reason="handoff_input_required")
    if type(timeout_ms) is not int or not 0 < timeout_ms <= MAX_TIMEOUT_MS:
        return _payload(USAGE, "refused", reason="handoff_timeout_invalid")

    try:
        root = path(bootstrap, directory=True)
    except (OSError, ValueError, KeyError, TypeError):
        return _payload(UNREACHABLE, "unreachable", reason="handoff_attempt_unreachable")
    try:
        _, binding_value = read_binding(EvidenceReader(), root, binding_sha256, expect_attempt)
    except FileNotFoundError:
        return _payload(UNREACHABLE, "unreachable", reason="handoff_attempt_unreachable",
                        detail={"attempt_binding": "missing"})
    except FilePinChanged:
        return _payload(USAGE, "refused", reason="file_pin_changed",
                        state="blocked_stale_or_mismatch")
    except BootstrapError as exc:
        return _payload(USAGE, "refused", reason=str(exc), state=exc.state)
    except PermissionError:
        return _payload(USAGE, "refused", reason="evidence_access_denied",
                        state="blocked_permission_denied")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError):
        return _payload(USAGE, "refused", reason="invalid_or_unreadable_evidence")

    try:
        if wait:
            argv = _check_argv(cli, types, timeout_ms)
            started = monotonic()
            returncode, stdout = runner(argv)
            elapsed_ms = (monotonic() - started) * 1000
            rows = _batch(None, (returncode, stdout, elapsed_ms, timeout_ms))
        else:
            try:
                raw = Path(receipt).read_bytes()
                captured = parse(raw)
            except (OSError, ValueError, TypeError):
                raise Refusal("handoff_delivery_unreadable", USAGE, state="not_admitted",
                              may_replay=True) from None
            rows = _batch(captured, None)
        row, value = _select(rows, expect_attempt)

        # Both assertions are always evaluated; neither may stand in for the other.
        pin = pin_error(value)
        sender = sender_error(row, binding_value)
        target = record_path(root, value["handoff_id"])
        _guard(target.parent)
        outcome, reason = _existing(target, value, row)
        if outcome is not None:
            return _payload(outcome, "duplicate" if outcome == ABSENT else "refused",
                            reason=reason, handoff_id=value["handoff_id"],
                            msg_id=row.get("id"), refs=value["refs"],
                            diagnostics={"pin": pin, "sender": sender})
        if pin is not None or sender is not None:
            return _payload(REFUSED, "refused", reason=pin or sender,
                            failures=[code for code in (pin, sender) if code],
                            handoff_id=value["handoff_id"], msg_id=row.get("id"),
                            diagnostics={"pin": pin, "sender": sender})
        record = _record_value(row, value, clock)
        _directory(target.parent)
        if _commit_record(target, record) == "duplicate":
            outcome, reason = _existing(target, value, row)
            return _payload(outcome, "duplicate" if outcome == ABSENT else "refused",
                            reason=reason, handoff_id=value["handoff_id"], msg_id=row.get("id"),
                            refs=value["refs"], diagnostics={"pin": pin, "sender": sender})
        ref = {"path": str(target), "sha256": digest(canonical(record) + b"\n")}
        return _payload(ACCEPTED, "accepted", handoff_id=value["handoff_id"],
                        msg_id=row.get("id"), from_handle=row.get("from_handle"),
                        refs=value["refs"], record=ref)
    except Refusal as refusal:
        return _payload(refusal.exit, "refused", reason=refusal.code,
                        state=refusal.state, **refusal.extra)


def cli_main(argv=None):
    parser = argparse.ArgumentParser(
        description="Accept a handoff mailbox delivery: pin bytes and sender, then record it.",
        epilog="Exit: 0 accepted, 3 nothing to do, 5 refused, 2 usage/transport/unwritable, "
               "4 attempt unreachable, 124 wait expired. Not authorization, not a gate input.")
    parser.add_argument("--bootstrap", required=True)
    parser.add_argument("--expect-attempt", required=True)
    parser.add_argument("--attempt-binding-sha256", required=True)
    parser.add_argument("--receipt", help="a captured `check --json` receipt file")
    parser.add_argument("--wait", action="store_true",
                        help="make one bounded `check --peek --wait` call instead of reading --receipt")
    parser.add_argument("--cli", default="orca")
    parser.add_argument("--types", default=HANDOFF_TYPE)
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if bool(args.receipt) == bool(args.wait):
        parser.error("exactly one of --receipt or --wait is required")
    if not 0 < args.timeout_ms <= MAX_TIMEOUT_MS:
        parser.error(f"--timeout-ms must be in 1..{MAX_TIMEOUT_MS}")

    payload = accept_handoff(bootstrap=args.bootstrap, expect_attempt=args.expect_attempt,
                             binding_sha256=args.attempt_binding_sha256, receipt=args.receipt,
                             wait=args.wait, cli=args.cli, types=args.types,
                             timeout_ms=args.timeout_ms)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(payload["outcome"])
    if payload["exit"] != ACCEPTED:
        print(f"{payload['outcome']}: {payload.get('reason', 'unknown')}; do not act",
              file=sys.stderr)
    return payload["exit"]


if __name__ == "__main__":
    raise SystemExit(cli_main())
