import copy
import json
import unittest
from unittest.mock import patch

from coordinator_io import read_json
from worker_usage_preserve import preserve
import trae.test_runtime_trae as runtime_trae_tests
from core.test_runtime_binding import NOW
from trae.test_trae_jsonl import event, timed_complete, counts


class WorkerUsagePreserveTests(unittest.TestCase):
    def setUp(self):
        self.f = runtime_trae_tests.RuntimeTraeTests()
        self.f.setUp()
        self.addCleanup(self.f.tearDown)
        self.f.native.worker["dispatch"].update(status="completed", completedAt="2026-10-13T00:05:00Z")
        self.f.native.worker["worker"]["state"] = "succeeded"
        self.f.native.worker["terminalResource"].update(releaseCompletedAt=None, terminalHandle="term-1",
            ownershipState="owned", ownerDispatchId="dispatch-1", releaseState="not_requested",
            releaseRequestedAt=None)
        self.f.records.extend([event(response="tail", at="2026-10-13T00:06:30Z"), timed_complete()])
        self.f.write_log()
        self.output = self.f.root / "preserved.json"

    def preserve(self):
        return preserve(self.f.native, self.f.options, "run-1", "dispatch-1", self.output, clock=lambda: NOW)

    def test_preserves_post_settlement_tail_without_release_final_or_secrets(self):
        result = self.preserve()
        receipt = read_json(self.output)
        sample = receipt["evidence"]["sample"]
        self.assertEqual(len(sample["raw_usage"]["requests"]), 2)
        self.assertEqual(sample["raw_usage"]["counts"], {k: v * 2 for k, v in counts().items()})
        self.assertEqual(len(sample["turns"]), 1)
        self.assertFalse(sample["complete"])
        self.assertFalse(result["final"])
        self.assertFalse(result["release_performed"])
        self.assertNotIn("SECRET", json.dumps(receipt))
        self.assertTrue(all(c == ("status",) or c[:2] in (("terminal", "show"),
            ("orchestration", "run-show"), ("orchestration", "worker-show")) for c in self.f.native.calls))
        raw = self.output.read_bytes()
        with self.assertRaisesRegex(ValueError, "output_exists"):
            self.preserve()
        self.assertEqual(raw, self.output.read_bytes())

    def test_released_unsettled_wrong_run_or_terminal_rejected(self):
        original = copy.deepcopy(self.f.native.worker)
        for section, key, value in [("dispatch", "status", "dispatched"),
                ("dispatch", "status", "failed"), ("worker", "state", "failed"),
                ("dispatch", "completedAt", None),
                ("dispatch", "runId", "other"), ("terminalResource", "releaseCompletedAt", "2026-10-13T00:06:00Z"),
                ("terminalResource", "terminalHandle", "other"),
                ("terminalResource", "ownershipState", "released"),
                ("terminalResource", "ownerDispatchId", "other"),
                ("terminalResource", "releaseState", "releasing"),
                ("terminalResource", "releaseState", "unknown"),
                ("terminalResource", "releaseRequestedAt", "2026-10-13T00:06:00Z")]:
            self.f.native.worker = copy.deepcopy(original)
            self.f.native.worker[section][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.preserve()
            self.assertFalse(self.output.exists())

    def test_failed_settled_worker_preserves_partial_usage(self):
        self.f.native.worker["dispatch"]["status"] = "failed"
        self.f.native.worker["worker"]["state"] = "failed"
        result = self.preserve()
        receipt = read_json(self.output)
        self.assertEqual(receipt["scope"]["dispatch_status"], "failed")
        self.assertEqual(receipt["scope"]["worker_state"], "failed")
        self.assertFalse(result["final"])
        self.assertFalse(result["release_performed"])
        self.assertEqual(len(receipt["evidence"]["sample"]["raw_usage"]["requests"]), 2)

    def test_outcome_change_during_capture_does_not_publish(self):
        from worker_usage_preserve import capture as real_capture
        def race(*args, **kwargs):
            evidence = real_capture(*args, **kwargs)
            self.f.native.worker["dispatch"]["status"] = "failed"
            self.f.native.worker["worker"]["state"] = "failed"
            return evidence
        with patch("worker_usage_preserve.capture", side_effect=race):
            with self.assertRaisesRegex(ValueError, "preserve_scope_changed"):
                self.preserve()
        self.assertFalse(self.output.exists())

    def test_permission_failure_does_not_retry_or_publish(self):
        with patch("worker_usage_preserve.capture", side_effect=PermissionError("denied")) as capture:
            with self.assertRaises(PermissionError):
                self.preserve()
            capture.assert_called_once()
        self.assertFalse(self.output.exists())

    def test_release_requested_during_capture_does_not_publish(self):
        from worker_usage_preserve import capture as real_capture
        def race(*args, **kwargs):
            evidence = real_capture(*args, **kwargs)
            self.f.native.worker["terminalResource"]["releaseState"] = "releasing"
            return evidence
        with patch("worker_usage_preserve.capture", side_effect=race):
            with self.assertRaisesRegex(ValueError, "unreleased_terminal"):
                self.preserve()
        self.assertFalse(self.output.exists())

    def test_release_race_and_session_mismatch_do_not_publish(self):
        reads = 0
        def change(argv):
            nonlocal reads
            if argv[:2] == ("orchestration", "worker-show"):
                reads += 1
                if reads == 2:
                    self.f.native.worker["terminalResource"]["releaseCompletedAt"] = "2026-10-13T00:10:30Z"
        self.f.native.on_read = change
        with self.assertRaisesRegex(ValueError, "unreleased_terminal"):
            self.preserve()
        self.assertFalse(self.output.exists())
        self.f.native.on_read = lambda _: None
        self.f.native.worker["terminalResource"]["releaseCompletedAt"] = None
        self.f.native.worker["providerSession"]["processIncarnation"] = "wrong"
        with self.assertRaisesRegex(Exception, "exact_provider_session_mismatch"):
            self.preserve()
        self.assertFalse(self.output.exists())
