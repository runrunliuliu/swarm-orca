"""Controlled waits on production paths; no NAS faults, native agents or service."""

from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
import errno
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

import blocking_io as blocking
import coordinator_io as io
import startup_execution as execution
import startup_runtime


class IsolationTests(unittest.TestCase):
    def test_timeout_keeps_slot_and_never_replays_or_joins(self):
        release, exited = threading.Event(), threading.Event()
        slots = threading.BoundedSemaphore(1)
        calls = []
        def stuck():
            calls.append(os.getpid())
            try:
                with blocking.stage("open", "/known/candidate"):
                    release.wait(3)
            finally:
                exited.set()
        with patch.object(blocking, "_slots", slots):
            try:
                start = time.monotonic()
                with self.assertRaises(blocking.BlockingIOTimeout) as caught:
                    blocking.run(stuck, seconds=.05, mutation=True)
                self.assertLess(time.monotonic() - start, 1)
                self.assertFalse(exited.is_set())
                self.assertEqual(caught.exception.details["events"][-1]["stage"], "open")
                self.assertFalse(caught.exception.details["execution_cancelled"])
                with self.assertRaisesRegex(ValueError, "capacity_exhausted"):
                    blocking.run(lambda: self.fail("retried"))
                self.assertEqual(calls, [os.getpid()])
            finally:
                release.set()
                self.assertTrue(exited.wait(2))

    def test_late_result_rejected_and_context_preserved(self):
        value = ContextVar("fixture", default="missing")
        value.set("original-context")
        self.assertEqual(blocking.run(value.get), "original-context")
        operation = blocking.Operation("outer", .1)
        with blocking.tracking(operation):
            def expire():
                operation.deadline = time.monotonic() - 1
                return "late-success"
            with self.assertRaises(blocking.BlockingIOTimeout):
                blocking.run(expire, seconds=999)

    def test_trace_never_waits_on_lock_or_writes_output(self):
        operation = blocking.Operation("trace")
        with patch("builtins.print", side_effect=AssertionError("sync output")):
            operation.emit("begin", "open")
            self.assertFalse(operation.snapshot()["partial"])
            operation.emit("end", "open")
            self.assertEqual([r["phase"] for r in operation.snapshot()["events"]], ["begin", "end"])
        for _ in range(100):
            operation.emit("begin", "read")
        self.assertEqual(len(operation.snapshot()["events"]), 64)
        self.assertEqual(operation.dropped, 38)

    def test_trace_concurrent_reader_cannot_drop_begin(self):
        operation = blocking.Operation("trace")
        reader = threading.Thread(target=lambda: [operation.snapshot() for _ in range(1000)])
        reader.start()
        for _ in range(32):
            operation.emit("begin", "open")
            operation.emit("end", "open")
        reader.join(2)
        self.assertFalse(reader.is_alive())
        result = operation.snapshot()
        self.assertEqual(result["dropped"], 0)
        self.assertEqual([r["phase"] for r in result["events"]], ["begin", "end"] * 32)

    def test_directory_stat_deadline_prevents_lock_open(self):
        operation = blocking.Operation("lock", 30)
        root = Mock()
        def stat():
            operation.deadline = time.monotonic() - 1
            return Mock()
        root.stat.side_effect = stat
        with blocking.tracking(operation), patch.object(io, "path", return_value=root), \
                patch.object(io.os, "open") as opened:
            with self.assertRaises(blocking.BlockingIOTimeout):
                with io.directory_lock("/fixture", "owner"):
                    self.fail("entered late lock")
        opened.assert_not_called()
        rows = [r for r in operation.snapshot()["events"] if r["stage"] == "lock_directory_stat"]
        self.assertEqual([r["phase"] for r in rows], ["begin", "failed"])

    def test_budget_validation(self):
        for seconds in (0, -1, True, float("nan"), float("inf")):
            with self.subTest(seconds=seconds), self.assertRaises(ValueError):
                blocking.run(lambda: None, seconds=seconds)

    def test_open_expiry_closes_fd_and_does_not_report_success(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "file"
            target.write_bytes(b"bytes")
            opened = []
            operation = blocking.Operation("read", 30)
            original = os.open
            def slow_open(*args, **kwargs):
                fd = original(*args, **kwargs)
                opened.append(fd)
                operation.deadline = time.monotonic() - 1
                return fd
            with blocking.tracking(operation), patch.object(io.os, "open", side_effect=slow_open):
                with self.assertRaises(blocking.BlockingIOTimeout):
                    io.read_bytes(target)
            for fd in opened:
                with self.assertRaises(OSError):
                    os.fstat(fd)

    def test_lock_contention_is_distinct_from_timeout_and_keeps_inode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with io.directory_lock(root, "owner"):
                inode = (root / "owner.lock").stat().st_ino
                with self.assertRaises(io.LockBusy):
                    blocking.run(lambda: self.acquire(root))
                self.assertEqual(inode, (root / "owner.lock").stat().st_ino)

    @staticmethod
    def acquire(root):
        with io.directory_lock(root, "owner", create=False):
            return True

    def test_late_flock_closes_fd_without_entering_body(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "owner.lock").touch(mode=0o600)
            operation = blocking.Operation("lock", 30)
            original = io.fcntl.flock
            def late(*args):
                original(*args)
                operation.deadline = time.monotonic() - 1
            with blocking.tracking(operation), patch.object(io.fcntl, "flock", side_effect=late):
                with self.assertRaises(blocking.BlockingIOTimeout):
                    self.acquire(root)
            self.assertTrue(self.acquire(root))

    def test_trigger_first_read_is_inside_budget(self):
        release, exited = threading.Event(), threading.Event()
        def stuck(*args):
            try:
                release.wait(3)
            finally:
                exited.set()
            blocking.check()
        original = blocking.run
        def short(function, **kwargs):
            return original(function, **(kwargs | {"seconds": .05}))
        with patch.object(execution, "trigger_candidate", side_effect=stuck), \
                patch.object(blocking, "run", side_effect=short), patch("operator_startup.load") as load:
            try:
                with self.assertRaises(blocking.BlockingIOTimeout):
                    execution.attest_trigger({}, {})
                load.assert_not_called()
            finally:
                release.set()
                self.assertTrue(exited.wait(2))


class WindowTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 5, tzinfo=timezone.utc)
        self.clock = patch.object(execution, "now", side_effect=lambda: self.now.isoformat())
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def value(self, deadline=500, expiry=600):
        return dict(valid_until=(self.now + timedelta(seconds=expiry)).isoformat(),
                    release_window=dict(deadline=(self.now + timedelta(seconds=deadline)).isoformat(),
                                        publish_budget_seconds=30, reserve_seconds=120))

    def test_window_takes_minimum_and_rejects_equality(self):
        execution.trigger_window(self.value(), publishing=True)
        for deadline, expiry in ((150, 600), (600, 150), (5, 600)):
            with self.assertRaisesRegex(ValueError, "window_insufficient"):
                execution.trigger_window(self.value(deadline, expiry), publishing=True)

    def test_consumer_rechecks_deadline_and_legacy_expiry(self):
        receipt = self.value(deadline=130)
        execution.trigger_window(receipt, publishing=False)
        self.now += timedelta(seconds=10)
        with self.assertRaisesRegex(ValueError, "window_insufficient"):
            execution.trigger_window(receipt, publishing=False)
        with self.assertRaisesRegex(ValueError, "readiness_expired"):
            execution.trigger_window(dict(valid_until=self.now.isoformat()), publishing=False)

    def test_consumer_reserves_release_time_against_both_deadlines(self):
        for deadline, expiry in ((120, 600), (600, 120), (1, 600)):
            with self.subTest(deadline=deadline, expiry=expiry), \
                    self.assertRaisesRegex(ValueError, "window_insufficient"):
                execution.trigger_window(self.value(deadline, expiry), publishing=False)
        execution.trigger_window(self.value(121, 121), publishing=False)
        execution.trigger_window(dict(valid_until=(self.now + timedelta(seconds=1)).isoformat()), publishing=False)

    def test_invalid_window_and_template_never_authorize(self):
        self.assertIsNone(execution.trigger_template(with_window=True)["decision"])
        self.assertNotIn("release_window", execution.trigger_template())
        for key, value in (("reserve_seconds", 119), ("publish_budget_seconds", True),
                           ("deadline", "no-time"), ("deadline", None)):
            item = self.value()
            item["release_window"][key] = value
            with self.assertRaises(ValueError):
                execution.trigger_window(item, publishing=True)

    def test_owner_final_context_expiry_prevents_publication(self):
        owner = Mock()
        owner.identity.authenticate.return_value = "operator"
        plan = dict(execution=dict(trigger=dict(readiness="/fixture/trigger-ready.json")))
        owner.runtime_context.return_value = (plan, {}, {})
        value = self.value()
        checks, published = [], []
        def local(*args, **kwargs):
            checks.append(True)
            if len(checks) == 2:
                self.now += timedelta(seconds=600)
            return plan, {}, {}
        def publish(target, value, recheck):
            recheck()
            published.append(target)
        owner.runtime_local.side_effect = local
        owner.runtime_publish.side_effect = publish
        with patch("bootstrap_identity.unchanged"), patch.object(execution, "trigger_review", return_value=value):
            with self.assertRaisesRegex(ValueError, "readiness_expired"):
                startup_runtime.operator_action(owner, {}, "runtime-attest-trigger",
                    dict(lifecycle={}, continuation={}, candidate={}), Mock())
        self.assertEqual(len(checks), 2)
        self.assertEqual(published, [])


if __name__ == "__main__":
    unittest.main()
