"""Handoff acceptance: two independent assertions, one non-consuming wait, one receipt."""

import io
import json
import os
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest import mock

import bootstrap_handoff
from coordinator_io import canonical, digest, parse
import bootstrap.test_bootstrap_events as events_tests


class HandoffAcceptTests(unittest.TestCase):
    def setUp(self):
        self.events = events_tests.BootstrapEventsTests()
        self.events.setUp()
        self.addCleanup(self.events.doCleanups)
        self.root = self.events.root
        self.binding = self.events.binding
        self.operator = self.events.b["operator"]["terminal"]
        self.ref = self.events.b["fixed_inputs"]["runtime_config"]
        self.other_ref = self.events.b["fixed_inputs"]["role_skill"]
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.receipts = Path(self.temp.name).resolve()

    def envelope(self, *, handoff_id="handoff-0001", attempt="attempt-test", refs=None,
                 subject="strict bootstrap handoff", **changes):
        value = {"schema_version": 1, "handoff_id": handoff_id, "attempt_id": attempt,
                 "refs": [self.ref] if refs is None else refs}
        value["payload_sha256"] = digest(canonical(value))
        value.update(changes)
        return value

    def row(self, *, sender=None, subject="strict bootstrap handoff", msg_id="msg-1",
            envelope=None, **changes):
        return {"id": msg_id, "type": "handoff", "subject": subject,
                "from_handle": self.operator if sender is None else sender,
                "payload": json.dumps(envelope if envelope is not None else self.envelope(**changes))}

    def receipt(self, rows, *, count=None, name="receipt.json"):
        value = {"ok": True, "result": {"messages": list(rows),
                                        "count": len(rows) if count is None else count}}
        target = self.receipts / name
        target.write_text(json.dumps(value))
        return str(target)

    def accept(self, **updates):
        args = dict(bootstrap=str(self.root), expect_attempt="attempt-test",
                    binding_sha256=self.binding["sha256"])
        args.update(updates)
        return bootstrap_handoff.accept_handoff(**args)

    def record(self, handoff_id="handoff-0001"):
        return Path(self.root) / "control" / "handoff" / (handoff_id + ".json")

    def test_may_replay_comes_from_one_table_and_unknown_is_false(self):
        # One truth, keyed by reason: the bit is a property of the finding, not of the exit code
        # it happens to share. A raise site cannot pass it at all.
        self.assertIs(bootstrap_handoff.may_replay("handoff_duplicate_no_effect"), False)
        self.assertIs(bootstrap_handoff.may_replay("handoff_absent_no_effect"), True)
        self.assertIs(bootstrap_handoff.may_replay("handoff_delivery_unreadable"), True)
        self.assertIs(bootstrap_handoff.may_replay("never_defined_anywhere"), False)
        self.assertIs(bootstrap_handoff.Refusal("handoff_duplicate_no_effect", 3).may_replay, False)
        with self.assertRaises(TypeError):
            bootstrap_handoff.Refusal("handoff_absent_no_effect", 3, may_replay=True)

    def test_acceptance_records_both_assertions_and_never_authorizes(self):
        result = self.accept(receipt=self.receipt([self.row()]))
        self.assertEqual(result["exit"], 0, result)
        self.assertTrue(result["ok"])
        self.assertEqual(result["from_handle"], self.operator)
        self.assertEqual(result["sender_anchor"], "binding-operator")
        self.assertEqual(result["refs"], [self.ref])
        record = parse(self.record().read_bytes())
        self.assertEqual(record["kind"], "strict_handoff_acceptance")
        self.assertEqual(record["handoff_id"], "handoff-0001")
        self.assertEqual(record["msg_id"], "msg-1")
        self.assertEqual(record["from_handle"], self.operator)
        self.assertEqual(record["payload_sha256"], self.envelope()["payload_sha256"])
        self.assertEqual(record["refs"], [self.ref])
        self.assertEqual(record["sender_anchor"], "binding-operator")
        self.assertIs(record["execution_authorized"], False)
        self.assertEqual(record["timestamp"], "unknown")  # the fixture row carries no timestamp
        self.assertIsNone(record["created_at"])
        # The receipt the caller keeps is the bytes on disk, pinned.
        self.assertEqual(record, parse(Path(result["record"]["path"]).read_bytes()))
        self.assertEqual(digest(canonical(record) + b"\n"), result["record"]["sha256"])
        self.assertEqual(os.stat(self.record().parent).st_mode & 0o777, 0o700)

    def test_the_two_assertions_are_independent_and_never_short_circuit(self):
        broken = {"path": self.ref["path"], "sha256": "0" * 64}
        cases = [
            ({"sender": self.operator, "refs": [self.ref]}, None),
            ({"sender": self.operator, "refs": [broken]}, "handoff_pin_mismatch"),
            ({"sender": "term_somebody_else", "refs": [self.ref]}, "handoff_sender_mismatch"),
            ({"sender": "term_somebody_else", "refs": [broken]}, "handoff_pin_mismatch"),
        ]
        for index, (shape, expected) in enumerate(cases):
            with self.subTest(shape=shape, expected=expected):
                result = self.accept(receipt=self.receipt(
                    [self.row(handoff_id="handoff-case%d" % index, **shape)]))
                self.assertEqual(result["exit"], 0 if expected is None else 5, result)
                if expected is not None:
                    self.assertEqual(result["reason"], expected)
                    self.assertFalse(self.record("handoff-case%d" % index).exists())
        both = self.accept(receipt=self.receipt(
            [self.row(handoff_id="handoff-both", sender="term_somebody_else", refs=[broken])],
            name="both.json"))
        # Neither assertion stands in for the other: the refusal names both findings.
        self.assertEqual(both["failures"],
                         ["handoff_pin_mismatch", "handoff_sender_mismatch"])

    def test_a_missing_or_unknown_sender_is_unanchored(self):
        for index, sender in enumerate(("unknown", None, "", "   ")):
            with self.subTest(sender=sender):
                row = self.row(handoff_id="handoff-sender%d" % index)
                if sender is None:
                    row.pop("from_handle")
                else:
                    row["from_handle"] = sender
                result = self.accept(receipt=self.receipt([row], name="sender%d.json" % index))
                self.assertEqual(result["exit"], 5)
                self.assertEqual(result["reason"], "handoff_sender_unanchored")
                self.assertFalse(self.record("handoff-sender%d" % index).exists())

    def test_an_identical_copy_is_no_effect_and_never_rewrites(self):
        receipt = self.receipt([self.row()])
        self.assertEqual(self.accept(receipt=receipt)["exit"], 0)
        before = self.record().read_bytes()
        again = self.accept(receipt=self.receipt([self.row(msg_id="msg-2")], name="again.json"))
        self.assertEqual(again["exit"], 3)
        self.assertEqual(again["reason"], "handoff_duplicate_no_effect")
        # A duplicate is a no-op, not a wait: replaying the same unread row is not progress, so
        # `may_replay` must be false even though it shares an exit code with "nothing arrived".
        self.assertIs(again["may_replay"], False)
        self.assertEqual(self.record().read_bytes(), before)

    def test_the_same_id_with_different_bytes_is_a_conflict(self):
        self.assertEqual(self.accept(receipt=self.receipt([self.row()]))["exit"], 0)
        before = self.record().read_bytes()
        for index, change in enumerate((
                dict(refs=[self.other_ref]),                  # different payload
                dict(subject="a different subject"),          # different subject
        )):
            with self.subTest(change=change):
                result = self.accept(receipt=self.receipt(
                    [self.row(**change)], name="conflict%d.json" % index))
                self.assertEqual(result["exit"], 5, result)
                self.assertEqual(result["reason"], "handoff_duplicate_conflict")
                self.assertEqual(self.record().read_bytes(), before)

    def test_the_same_id_from_another_pane_is_a_conflict_not_a_copy(self):
        self.assertEqual(self.accept(receipt=self.receipt([self.row()]))["exit"], 0)
        result = self.accept(receipt=self.receipt(
            [self.row(sender="term_somebody_else")], name="other-pane.json"))
        # A "same handoff" resent by a different sender is not the same handoff.
        self.assertEqual(result["exit"], 5)
        self.assertEqual(result["reason"], "handoff_duplicate_conflict")

    def test_empty_batch_and_foreign_attempt_are_absent_not_errors(self):
        empty = self.accept(receipt=str(self.write({"ok": True, "result": {
            "messages": [], "count": 0}}, "empty.json")))
        self.assertEqual(empty["exit"], 3)
        self.assertEqual(empty["reason"], "handoff_absent_no_effect")
        self.assertTrue(empty["may_replay"])  # waiting again is allowed; writing again is not
        foreign = self.accept(receipt=self.receipt(
            [self.row(attempt="some-other-attempt")], name="foreign.json"))
        self.assertEqual(foreign["exit"], 3)
        self.assertEqual(foreign["reason"], "handoff_absent_no_effect")

    def test_payload_shape_and_digest_are_checked_before_any_assertion(self):
        good = self.envelope()
        cases = {
            "not-json": "definitely not json",
            "extra-field": dict(good, next_hop=["run"]),
            "wrong-attempt-type": dict(good, attempt_id=7),
            "empty-refs": dict(good, refs=[]),
            "bad-ref": dict(good, refs=[{"path": str(self.root), "sha256": "short"}]),
            "bad-id": dict(good, handoff_id="../escape"),
        }
        for index, (name, payload) in enumerate(cases.items()):
            with self.subTest(case=name):
                row = self.row()
                row["payload"] = payload if isinstance(payload, str) else json.dumps(payload)
                result = self.accept(receipt=self.receipt([row], name="shape%d.json" % index))
                self.assertEqual(result["exit"], 5, result)
                self.assertEqual(result["reason"], "handoff_payload_invalid")
        tampered = dict(good, payload_sha256="0" * 64)
        result = self.accept(receipt=self.receipt([self.row(envelope=tampered)], name="digest.json"))
        self.assertEqual(result["reason"], "handoff_payload_invalid")
        self.assertEqual(result["diagnostics"]["field"], "payload_sha256")
        self.assertFalse(self.record().exists())

    def test_two_handoffs_for_one_attempt_in_one_batch_are_not_arbitrated(self):
        rows = [self.row(handoff_id="handoff-a"), self.row(handoff_id="handoff-b", msg_id="msg-2")]
        result = self.accept(receipt=self.receipt(rows, name="two.json"))
        self.assertEqual(result["exit"], 5)
        self.assertEqual(result["reason"], "handoff_duplicate_conflict")
        self.assertEqual(result["diagnostics"], {"batch": "multiple_handoff_ids"})
        self.assertFalse(self.record("handoff-a").exists())

    def test_one_id_with_different_content_in_one_batch_is_a_conflict(self):
        # A repeated id is only "the same delivery" when all five compared fields agree. Anything
        # else means two handoffs wearing one id, and the receiver must not take the first row.
        good = self.row(handoff_id="handoff-copy")
        variants = {
            "payload": self.row(handoff_id="handoff-copy", msg_id="msg-2", refs=[self.other_ref]),
            "sender": self.row(handoff_id="handoff-copy", msg_id="msg-2",
                               sender="term_somebody_else"),
            "subject": self.row(handoff_id="handoff-copy", msg_id="msg-2", subject="another one"),
        }
        for index, (name, other) in enumerate(variants.items()):
            with self.subTest(field=name):
                result = self.accept(receipt=self.receipt(
                    [good, other], name="same-id-%d.json" % index))
                self.assertEqual(result["exit"], 5, result)
                self.assertEqual(result["reason"], "handoff_duplicate_conflict")
                self.assertEqual(result["diagnostics"], {"batch": "same_id_different_content"})
                self.assertFalse(self.record("handoff-copy").exists())

    def test_one_id_with_identical_rows_is_one_delivery(self):
        rows = [self.row(handoff_id="handoff-dup"),
                self.row(handoff_id="handoff-dup", msg_id="msg-2")]
        result = self.accept(receipt=self.receipt(rows, name="same-id-ok.json"))
        self.assertEqual(result["exit"], 0, result)
        self.assertEqual(result["msg_id"], "msg-1")  # FIFO: the first copy is the one recorded
        self.assertEqual(parse(self.record("handoff-dup").read_bytes())["msg_id"], "msg-1")

    def test_a_malformed_row_for_another_attempt_still_blocks_the_batch(self):
        # Fail-closed by decision: an unreadable mailbox row is not a row we may skip past.
        foreign = self.row(handoff_id="handoff-foreign", msg_id="msg-2", attempt="other-attempt")
        foreign["payload"] = "not json"
        result = self.accept(receipt=self.receipt([self.row(), foreign], name="foreign-bad.json"))
        self.assertEqual(result["exit"], 5, result)
        self.assertEqual(result["reason"], "handoff_payload_invalid")
        self.assertFalse(self.record().exists())

    def test_wait_path_peeks_and_makes_exactly_one_bounded_call(self):
        calls = []

        def runner(argv):
            calls.append(argv)
            return 0, json.dumps({"ok": True, "result": {
                "messages": [self.row()], "count": 1}})

        result = self.accept(wait=True, runner=runner, timeout_ms=30000)
        self.assertEqual(result["exit"], 0, result)
        self.assertEqual(len(calls), 1)
        self.assertIn("--peek", calls[0])
        self.assertIn("--wait", calls[0])
        self.assertEqual(calls[0][calls[0].index("--types") + 1], "handoff")
        self.assertEqual(calls[0][calls[0].index("--timeout-ms") + 1], "30000")
        self.assertEqual(calls[0][-1], "--json")

    def test_a_spent_window_is_a_timeout_not_an_empty_batch(self):
        # Measured on this runtime: an elapsed `check --wait` answers `ok:true, count:0` with
        # exit 0, so the classification must come from shape plus this tool's own clock.
        spent = [0.0, 2.5]

        def runner(argv):
            return 0, json.dumps({"ok": True, "result": {"messages": [], "count": 0}})

        result = self.accept(wait=True, runner=runner, timeout_ms=2000,
                             monotonic=lambda: spent.pop(0))
        self.assertEqual(result["exit"], 124, result)
        self.assertEqual(result["reason"], "handoff_wait_timeout")
        empty = self.accept(wait=True, timeout_ms=2000, monotonic=lambda: 0.0,
                            runner=lambda argv: (0, json.dumps({"ok": True, "result": {
                                "messages": [], "count": 0}})))
        self.assertEqual(empty["exit"], 3)

    def test_an_unreadable_or_killed_cli_consumes_nothing(self):
        for index, answer in enumerate(((1, ""), (0, "not json"), (0, ""))):
            with self.subTest(answer=answer):
                result = self.accept(wait=True, runner=lambda argv, a=answer: a)
                self.assertEqual(result["exit"], 2, result)
                self.assertEqual(result["reason"], "handoff_delivery_unreadable")
                self.assertEqual(result["state"], "not_admitted")
                self.assertTrue(result["may_replay"])
                self.assertFalse(self.record().exists())

    def test_an_unreadable_captured_receipt_is_not_a_normalization_gap(self):
        for index, payload in enumerate(("not json", "", '{"ok": true, "result": "text"}')):
            with self.subTest(payload=payload):
                target = self.receipts / ("bad%d.json" % index)
                target.write_text(payload)
                result = self.accept(receipt=str(target))
                self.assertEqual(result["exit"], 2, result)
                # Whatever the shape, it is either unreadable or carries no row: never "accepted".
                self.assertIn(result["reason"],
                              ("handoff_delivery_unreadable", "handoff_absent_no_effect"))
                self.assertFalse(self.record().exists())

    def test_a_runtime_without_peek_wait_fails_closed_instead_of_consuming(self):
        # An old runtime answers `peek_wait_unsupported`; the tool must not fall back to a
        # consuming `--wait` (which would mark the handoff read with no record of it).
        calls = []

        def runner(argv):
            calls.append(argv)
            return 1, json.dumps({"ok": False, "error": {"code": "peek_wait_unsupported"}})

        result = self.accept(wait=True, runner=runner)
        self.assertEqual(result["exit"], 2, result)
        self.assertEqual(result["reason"], "handoff_delivery_unreadable")
        self.assertEqual(len(calls), 1)
        self.assertIn("--peek", calls[0])
        self.assertFalse(self.record().exists())

    def test_accepted_at_is_taken_after_the_wait_finishes(self):
        # Live finding: the clock was read when the call started, so a handoff that waited five
        # seconds recorded an `accepted_at` older than the delivery's own `created_at` — an
        # inversion a reader would have to explain away. The stamp belongs to the record, i.e.
        # after the delivery was read.
        order = []
        stamp = "2026-11-12T16:00:00+00:00"

        def runner(argv):
            order.append("read")
            return 0, json.dumps({"ok": True,
                                  "result": {"messages": [self.row()], "count": 1}})

        def clock():
            order.append("clock")
            return stamp

        with mock.patch.object(bootstrap_handoff, "now", clock):
            result = self.accept(wait=True, runner=runner)
        self.assertEqual(result["exit"], 0, result)
        self.assertEqual(order, ["read", "clock"])
        self.assertEqual(json.loads(self.record().read_text())["accepted_at"], stamp)

    def test_a_record_that_reads_back_differently_needs_reconciliation(self):
        def publish(target, value):
            Path(target).write_bytes(b'{"something": "else"}\n')

        with mock.patch.object(bootstrap_handoff, "publish_new", publish):
            result = self.accept(receipt=self.receipt([self.row()]))
        self.assertEqual(result["exit"], 5, result)
        self.assertEqual(result["reason"], "handoff_record_conflict")
        self.assertEqual(result["state"], "needs_reconcile")
        self.assertEqual(result["diagnostics"], {"bytes": "different"})

    def test_a_link_whose_directory_fsync_failed_is_not_accepted(self):
        # `publish_new` links first and fsyncs the parent directory second. Equal bytes therefore
        # prove the link landed, not that the directory entry is durable — and "the receipt exists
        # but is not durable" must not be reported as accepted.
        writes = []

        def publish(target, value):
            writes.append(Path(target))
            Path(target).write_bytes(canonical(value) + b"\n")
            raise OSError("fsync of the parent directory failed")

        with mock.patch.object(bootstrap_handoff, "publish_new", publish):
            result = self.accept(receipt=self.receipt([self.row()]))
        self.assertEqual(result["exit"], 5, result)
        self.assertEqual(result["reason"], "handoff_record_conflict")
        self.assertEqual(result["state"], "needs_reconcile")
        self.assertEqual(result["diagnostics"],
                         {"directory_durability": "unverified", "bytes": "visible"})
        self.assertFalse(result["may_replay"])
        self.assertEqual(writes, [self.record()])  # exactly one link attempt, never a second write

    def test_an_unwritable_record_is_not_admitted_and_may_be_retried(self):
        def broken(target, value):
            raise OSError("disk full")

        with mock.patch.object(bootstrap_handoff, "publish_new", broken):
            result = self.accept(receipt=self.receipt([self.row()]))
        self.assertEqual(result["exit"], 2, result)
        self.assertEqual(result["reason"], "handoff_record_unwritable")
        self.assertEqual(result["state"], "not_admitted")
        self.assertTrue(result["may_replay"])
        self.assertFalse(self.record().exists())
        # Nothing was consumed, so the same receipt still accepts after the write path recovers.
        self.assertEqual(self.accept(receipt=self.receipt([self.row()], name="retry.json"))["exit"], 0)

    def test_an_unsafe_record_directory_is_refused(self):
        (self.root / "control").mkdir(exist_ok=True)
        (self.root / "control" / "handoff").write_text("not a directory")
        result = self.accept(receipt=self.receipt([self.row()]))
        self.assertEqual(result["exit"], 5, result)
        self.assertEqual(result["reason"], "handoff_record_dir_unsafe")
        self.assertEqual(result["diagnostics"],
                         {"directory": "control/handoff", "problem": "not_a_directory"})

    def test_a_symlinked_record_directory_is_never_followed(self):
        elsewhere = self.receipts / "elsewhere"
        elsewhere.mkdir(mode=0o700)
        (self.root / "control").mkdir(exist_ok=True)
        os.chmod(self.root / "control", 0o700)
        (self.root / "control" / "handoff").symlink_to(elsewhere, target_is_directory=True)
        result = self.accept(receipt=self.receipt([self.row()]))
        self.assertEqual(result["exit"], 5, result)
        self.assertEqual(result["reason"], "handoff_record_dir_unsafe")
        self.assertEqual(result["diagnostics"],
                         {"directory": "control/handoff", "problem": "symlink"})
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_a_mode_drifted_record_directory_is_refused_not_repaired(self):
        # Repairing the mode would hide that something else wrote into this tree; the tool reports
        # instead, so the operator sees the drift.
        (self.root / "control").mkdir(mode=0o700, exist_ok=True)
        os.chmod(self.root / "control", 0o700)
        handoff = self.root / "control" / "handoff"
        handoff.mkdir(mode=0o700)
        os.chmod(handoff, 0o755)
        result = self.accept(receipt=self.receipt([self.row()]))
        self.assertEqual(result["exit"], 5, result)
        self.assertEqual(result["reason"], "handoff_record_dir_unsafe")
        self.assertEqual(result["diagnostics"],
                         {"directory": "control/handoff", "problem": "mode", "mode": "0o755"})
        self.assertEqual(os.stat(handoff).st_mode & 0o777, 0o755)  # untouched
        self.assertFalse(self.record().exists())

    def test_directory_preparation_failures_are_typed_not_escaping(self):
        # mkdir/chmod/fsync raising must come back as a refusal the caller can route, not as a
        # traceback: creating the level may already have happened, so it is needs_reconcile.
        cases = {
            "mkdir": mock.patch.object(Path, "mkdir", side_effect=OSError("no space")),
            "chmod": mock.patch.object(bootstrap_handoff.os, "chmod", side_effect=OSError("denied")),
            "fsync": mock.patch.object(bootstrap_handoff, "fsync_dir",
                                       side_effect=OSError("fsync failed")),
        }
        for index, (step, patch) in enumerate(cases.items()):
            with self.subTest(step=step):
                with patch:
                    result = self.accept(receipt=self.receipt(
                        [self.row(handoff_id="handoff-dir%d" % index)],
                        name="dir-%s.json" % step))
                self.assertEqual(result["exit"], 5, result)
                self.assertEqual(result["reason"], "handoff_record_dir_unproven")
                self.assertEqual(result["state"], "needs_reconcile")
                self.assertIs(result["may_replay"], False)
                self.assertFalse(self.record("handoff-dir%d" % index).exists())

    def test_a_retry_re_fsyncs_both_levels_before_writing(self):
        # The first attempt creates the directories and fails on the fsync. The directory now
        # exists, so a retry that skipped existing levels would inherit an unproven entry — it has
        # to fsync both parents again and only then write.
        calls = []
        failures = {"remaining": 1}

        def fsync(target):
            calls.append(Path(target).name)
            if failures["remaining"]:
                failures["remaining"] -= 1
                raise OSError("fsync failed")

        with mock.patch.object(bootstrap_handoff, "fsync_dir", fsync):
            first = self.accept(receipt=self.receipt([self.row()], name="r1.json"))
            self.assertEqual(first["exit"], 5, first)
            self.assertEqual(first["reason"], "handoff_record_dir_unproven")
            self.assertFalse(self.record().exists())
            # The level exists now, but its durability was never proven.
            self.assertTrue((self.root / "control").is_dir())
            calls.clear()
            second = self.accept(receipt=self.receipt([self.row()], name="r2.json"))
        self.assertEqual(second["exit"], 0, second)
        self.assertEqual(calls, [self.root.name, "control"])
        self.assertEqual(parse(self.record().read_bytes())["handoff_id"], "handoff-0001")

    def test_creation_fsyncs_each_parent_in_order(self):
        order = []

        def fsync(target):
            order.append(("fsync", Path(target).name))

        def publish(target, value):
            order.append(("publish", Path(target).name))
            Path(target).write_bytes(canonical(value) + b"\n")

        with mock.patch.object(bootstrap_handoff, "fsync_dir", fsync):
            with mock.patch.object(bootstrap_handoff, "publish_new", publish):
                result = self.accept(receipt=self.receipt([self.row()]))
        self.assertEqual(result["exit"], 0, result)
        # control/ created -> fsync root; control/handoff/ created -> fsync control; then the write.
        self.assertEqual(order, [("fsync", self.root.name), ("fsync", "control"),
                                 ("publish", "handoff-0001.json")])
        self.assertEqual(os.stat(self.root / "control").st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.root / "control" / "handoff").st_mode & 0o777, 0o700)

    def test_an_unstartable_cli_is_a_transport_answer_not_a_crash(self):
        def missing(argv):
            raise FileNotFoundError("no such executable")

        result = self.accept(wait=True, runner=missing)
        self.assertEqual(result["exit"], 2, result)
        self.assertEqual(result["reason"], "handoff_delivery_unreadable")
        self.assertEqual(result["state"], "not_admitted")
        self.assertTrue(result["may_replay"])
        self.assertFalse(self.record().exists())

    def test_the_receipt_path_never_spawns_or_opens_a_socket(self):
        with mock.patch.object(socket, "socket", side_effect=AssertionError("no socket")):
            with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("no process")):
                result = self.accept(receipt=self.receipt([self.row()]))
        self.assertEqual(result["exit"], 0)
        self.assertFalse((self.root / "control" / "owner.json").exists())

    def test_the_cli_entry_reports_an_unstartable_process_without_a_traceback(self):
        with mock.patch.object(subprocess, "run", side_effect=OSError("exec format error")):
            out = io.StringIO()
            with redirect_stdout(out), redirect_stderr(io.StringIO()):
                code = bootstrap_handoff.cli_main([
                    "--bootstrap", str(self.root), "--expect-attempt", "attempt-test",
                    "--attempt-binding-sha256", self.binding["sha256"], "--wait", "--json"])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(out.getvalue())["reason"], "handoff_delivery_unreadable")

    def test_cli_requires_exactly_one_input_mode(self):
        common = ["--bootstrap", str(self.root), "--expect-attempt", "attempt-test",
                  "--attempt-binding-sha256", self.binding["sha256"]]
        for extra in (["--receipt", self.receipt([self.row()]), "--wait"], []):
            with self.subTest(extra=extra):
                with redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as raised:
                        bootstrap_handoff.cli_main(common + extra)
                self.assertEqual(raised.exception.code, 2)
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = bootstrap_handoff.cli_main(
                common + ["--receipt", self.receipt([self.row()], name="cli.json"), "--json"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())["outcome"], "accepted")

    def write(self, value, name):
        target = self.receipts / name
        target.write_text(json.dumps(value))
        return target


if __name__ == "__main__":
    unittest.main()
