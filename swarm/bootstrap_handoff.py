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
import stat
import subprocess
import sys
import time

from bootstrap_events import BootstrapError, EvidenceReader, binding as read_binding
from coordinator_io import (FilePinChanged, canonical, digest, fsync_dir, now, path, pinned,
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


# Whether the caller may re-enter instead of reconciling first. One table, keyed by reason: the
# bit is a property of the *finding*, and deriving it from an exit code let a duplicate (a no-op
# that may not be replayed) inherit `may_replay: true` from the "absent" outcome it shares a code
# with. Raising sites therefore cannot pass this bit at all.
#
# Only "nothing was written and nothing was consumed" is replayable, and even then it means "wait
# again", never "write again". Everything else — conflicts, pin/sender mismatches, an unproven
# durability — must be reconciled before another attempt.
MAY_REPLAY = {
    "handoff_absent_no_effect": True,    # nothing arrived: waiting again is the whole action
    "handoff_wait_timeout": True,        # wait family, nothing consumed
    "handoff_delivery_unreadable": True,  # no receipt read, nothing consumed
    "handoff_record_unwritable": True,   # nothing linked, nothing consumed
    "handoff_duplicate_no_effect": False,  # no-op: replaying the same unread row is not progress
    "handoff_duplicate_conflict": False,
    "handoff_pin_mismatch": False,
    "handoff_sender_mismatch": False,
    "handoff_sender_unanchored": False,
    "handoff_payload_invalid": False,
    "handoff_record_conflict": False,
    "handoff_record_dir_unsafe": False,
    "handoff_record_dir_unproven": False,
    "handoff_attempt_unreachable": False,
    "handoff_input_required": False,
    "handoff_input_ambiguous": False,
    "handoff_timeout_invalid": False,
}


def may_replay(reason):
    """From `MAY_REPLAY` only. An unknown reason is not replayable: silence is not permission."""
    return MAY_REPLAY.get(reason, False)


class Refusal(ValueError):
    """A typed refusal: `code` is the reason, `exit` the status, `state` the P0 outcome class.

    `may_replay` is read from the table above, never passed in, so two call sites cannot disagree
    about the same code.
    """

    def __init__(self, code, exit_code, state=None, *, detail=None):
        # `detail` is the only keyword a raise site may add, and the signature is closed on
        # purpose: accepting `**extra` would let a site pass `may_replay` again and silently
        # bypass the table.
        super().__init__(code)
        self.code = code
        self.exit = exit_code
        self.state = state
        self.extra = {} if detail is None else {"detail": detail}

    @property
    def may_replay(self):
        return may_replay(self.code)


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


def _levels(target):
    """The two directory levels a receipt needs: `control/`, then `control/handoff/`."""
    handoff = Path(target)
    control = handoff.parent
    return ((control, "control", control.parent), (handoff, "control/handoff", control))


def _verify(target, label):
    """Refuse one level unless it is either absent or a plain 0700 directory.

    Not "close enough": a symlink here writes the receipt somewhere this attempt does not control,
    and a group/world-readable directory exposes delivery identities and message ids. Mode drift is
    reported rather than repaired — repairing it would hide that something else wrote in this tree.
    """
    target = Path(target)
    if target.is_symlink():
        raise Refusal("handoff_record_dir_unsafe", REFUSED,
                      detail={"directory": label, "problem": "symlink"})
    if target.exists() and not target.is_dir():
        raise Refusal("handoff_record_dir_unsafe", REFUSED,
                      detail={"directory": label, "problem": "not_a_directory"})
    if target.exists():
        mode = stat.S_IMODE(target.stat().st_mode)
        if mode != 0o700:
            raise Refusal("handoff_record_dir_unsafe", REFUSED,
                          detail={"directory": label, "problem": "mode", "mode": oct(mode)})
    return target


def _guard(target):
    """Refuse an unsafe record directory without creating or writing anything."""
    for level, label, _parent in _levels(target):
        _verify(level, label)
    return Path(target)


def _directory(target):
    """Create `control/` and `control/handoff/` at 0700 and fsync each level's parent.

    Two rules this function exists to keep:

    * **Every level's parent is fsynced on every call, not only when this call created it.** A
      previous attempt may have created the directory and failed before its parent was durable;
      `if level.exists(): continue` then used to skip exactly the fsync that was missing, so a
      retry built the receipt on a directory entry nobody had ever proven. `fsync` is idempotent
      and cheap, so the retry repairs durability instead of inheriting the gap.
    * **A failure here is a typed refusal, never an escaping `OSError`.** Creating the level may
      already have happened, so this is not `not_admitted`: it is "something happened and its
      durability is unproven", i.e. `needs_reconcile` (`handoff_record_dir_unproven`).

    The receipt write itself stays with `publish_new`, which fsyncs the directory it writes into.
    """
    for level, label, parent in _levels(target):
        _verify(level, label)
        if not level.exists():
            try:
                level.mkdir(mode=0o700)
                os.chmod(level, 0o700)
            except OSError:
                raise Refusal("handoff_record_dir_unproven", REFUSED, state="needs_reconcile",
                              detail={"directory": label, "step": "create"}) from None
        try:
            fsync_dir(parent)
        except OSError:
            raise Refusal("handoff_record_dir_unproven", REFUSED, state="needs_reconcile",
                          detail={"directory": label, "step": "fsync"}) from None
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


def _identity(value, row):
    """The five fields that decide "same delivery" vs "different delivery".

    Used in both places that compare two claims of one `handoff_id`: rows of the same batch, and a
    delivery against an existing acceptance record. One helper, so the two comparisons can never
    drift into testing different things.
    """
    return {"payload_sha256": value["payload_sha256"], "refs": value["refs"],
            "from_handle": row.get("from_handle"), "subject": row.get("subject"),
            "sender_anchor": SENDER_ANCHOR}


def _existing(target, value, row):
    """Duplicate vs conflict against an existing record: (exit_code, reason) or (None, None)."""
    recorded = _read_record(target)
    if recorded is None:
        return None, None
    candidate = _identity(value, row)
    for field in COMPARED_FIELDS:
        if not isinstance(recorded, dict) or recorded.get(field) != candidate[field]:
            # Same id, different content: id reuse or a rewritten handoff. Not ours to arbitrate.
            return REFUSED, "handoff_duplicate_conflict"
    return ABSENT, "handoff_duplicate_no_effect"


def _commit_record(target, value):
    """Write the receipt, then classify by reading the bytes back (the P0 discipline).

    `publish_new` links complete temporary bytes onto the target and only *then* fsyncs the parent
    directory, so the two failures after a link are not the same fact:

    * nothing linked (the target is not there) = not admitted, safe to try again;
    * linked but the directory fsync did not complete = the bytes are visible and their durability
      is unproven. A read-back cannot prove a missing fsync, so this is `needs_reconcile` and never
      "accepted": treating equal bytes as success is exactly how "the receipt is there but not
      durable" would be reported as done.

    Returns `"duplicate"` when another claimant already linked that path (FileExistsError).
    """
    raw = canonical(value) + b"\n"
    unproven = None
    try:
        publish_new(Path(target), value)
    except FileExistsError:
        return "duplicate"
    except OSError:
        # The exception cannot tell us which step failed; the read-back can tell whether a link
        # landed, and only "no link at all" is retryable.
        unproven = "directory_durability_unverified"
    try:
        actual = Path(target).read_bytes()
    except FileNotFoundError:
        raise Refusal("handoff_record_unwritable", USAGE, state="not_admitted") from None
    except OSError:
        raise Refusal("handoff_record_conflict", REFUSED, state="needs_reconcile",
                      detail={"directory_durability": "unverified"}) from None
    if unproven is not None:
        raise Refusal("handoff_record_conflict", REFUSED, state="needs_reconcile",
                      detail={"directory_durability": "unverified", "bytes": "visible"})
    if actual != raw:
        raise Refusal("handoff_record_conflict", REFUSED, state="needs_reconcile",
                      detail={"bytes": "different"})
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
            raise Refusal("handoff_delivery_unreadable", USAGE, state="not_admitted")
    if payload is None:
        raise Refusal("handoff_delivery_unreadable", USAGE, state="not_admitted")
    # "Empty" must mean a complete receipt that says so, never a body this tool could not read:
    # treating a malformed `result` as "nothing to do" is exactly the silent-empty failure that
    # makes a caller re-enter a wait it should have reported.
    body = unwrap(payload)
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        raise Refusal("handoff_delivery_unreadable", USAGE, state="not_admitted")
    rows = rows_of(payload)
    if not isinstance(rows, list):
        raise Refusal("handoff_delivery_unreadable", USAGE, state="not_admitted")
    return rows


def _select(rows, expect_attempt):
    """(row, value) for this attempt, or a Refusal carrying the exit status.

    Rows are grouped by `handoff_id` before anything is chosen. Two rows of one attempt with one id
    are only "the same delivery" when all five compared fields agree; otherwise the batch contains
    two different handoffs wearing one id, which the receiver must not resolve by taking the first
    one. Different ids for one attempt are the same conflict, not a choice either.

    A handoff row whose envelope cannot be parsed stops the batch even when it names another
    attempt: a mailbox we cannot read is not a mailbox we may skip past. That is deliberate
    fail-closed behaviour, stated in the protocol section, not an oversight.
    """
    handoffs = [row for row in rows if isinstance(row, dict) and row.get("type") == HANDOFF_TYPE]
    if not handoffs:
        raise Refusal("handoff_absent_no_effect", ABSENT)
    ours = {}
    for row in handoffs:
        value = envelope(row)
        if value["attempt_id"] != expect_attempt:
            continue
        ours.setdefault(value["handoff_id"], []).append((row, value))
    if not ours:
        raise Refusal("handoff_absent_no_effect", ABSENT)
    if len(ours) > 1:
        # Two different handoffs for one attempt in one batch: do not pick one.
        raise Refusal("handoff_duplicate_conflict", REFUSED,
                      detail={"batch": "multiple_handoff_ids"})
    copies = next(iter(ours.values()))
    first = _identity(copies[0][1], copies[0][0])
    for row, value in copies[1:]:
        if _identity(value, row) != first:
            # One id, two contents in one batch. Same verdict as a rewritten record.
            raise Refusal("handoff_duplicate_conflict", REFUSED,
                          detail={"batch": "same_id_different_content"})
    return copies[0]


def _check_argv(cli, types, timeout_ms):
    """The only wait shape this module uses: one bounded, non-consuming check.

    `--peek` is not optional. A consuming `check` marks the batch read, so a crash between reading
    and recording would lose the handoff with nothing to show for it; peeking leaves the message
    where a re-entry can find it, which is what makes the duplicate path the repair path.
    """
    return [cli, "orchestration", "check", "--peek", "--wait", "--types", types,
            "--timeout-ms", str(timeout_ms), "--json"]


def _invoke(argv):
    """One bounded CLI call; `(None, "")` when the CLI could not even start.

    A missing or non-executable `orca` is a transport answer, not a crash: `classify` maps a
    non-zero/absent exit to USAGE_OR_TRANSPORT, which this module reports as an unreadable delivery
    (nothing consumed, retryable). Letting `OSError` escape here would turn a deployment mistake
    into a stack trace the caller cannot classify.
    """
    try:
        completed = subprocess.run(argv, capture_output=True, text=True)
    except OSError:
        return None, ""
    return completed.returncode, completed.stdout


def accept_handoff(*, bootstrap, expect_attempt, binding_sha256, receipt=None,
                   wait=False, cli="orca", types=HANDOFF_TYPE, timeout_ms=DEFAULT_TIMEOUT_MS,
                   runner=None, clock=None, monotonic=None):
    """One acceptance decision. Returns the payload; `payload["exit"]` is the status."""
    runner = _invoke if runner is None else runner
    monotonic = time.monotonic if monotonic is None else monotonic
    # `clock` is resolved at the record site, not here: the acceptance time is when the decision
    # was taken. Resolving it on entry made a handoff that waited five seconds record an
    # `accepted_at` five seconds older than the delivery's own `created_at` (live finding).
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
            try:
                returncode, stdout = runner(argv)
            except OSError:
                # An injected runner and the real CLI fail the same way: no answer, nothing
                # consumed. `classify` reads an absent exit status as a transport result.
                returncode, stdout = None, ""
            elapsed_ms = (monotonic() - started) * 1000
            rows = _batch(None, (returncode, stdout, elapsed_ms, timeout_ms))
        else:
            try:
                raw = Path(receipt).read_bytes()
                captured = parse(raw)
            except (OSError, ValueError, TypeError):
                raise Refusal("handoff_delivery_unreadable", USAGE, state="not_admitted") from None
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
                            reason=reason, may_replay=may_replay(reason),
                            handoff_id=value["handoff_id"], msg_id=row.get("id"),
                            refs=value["refs"], diagnostics={"pin": pin, "sender": sender})
        if pin is not None or sender is not None:
            return _payload(REFUSED, "refused", reason=pin or sender,
                            failures=[code for code in (pin, sender) if code],
                            handoff_id=value["handoff_id"], msg_id=row.get("id"),
                            diagnostics={"pin": pin, "sender": sender})
        record = _record_value(row, value, clock if clock is not None else timestamp(now()))
        _directory(target.parent)
        if _commit_record(target, record) == "duplicate":
            outcome, reason = _existing(target, value, row)
            return _payload(outcome, "duplicate" if outcome == ABSENT else "refused",
                            reason=reason, may_replay=may_replay(reason),
                            handoff_id=value["handoff_id"], msg_id=row.get("id"),
                            refs=value["refs"], diagnostics={"pin": pin, "sender": sender})
        ref = {"path": str(target), "sha256": digest(canonical(record) + b"\n")}
        return _payload(ACCEPTED, "accepted", handoff_id=value["handoff_id"],
                        msg_id=row.get("id"), from_handle=row.get("from_handle"),
                        refs=value["refs"], record=ref)
    except Refusal as refusal:
        return _payload(refusal.exit,
                        "absent" if refusal.exit == ABSENT else "refused",
                        reason=refusal.code, state=refusal.state,
                        may_replay=refusal.may_replay, **refusal.extra)


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
