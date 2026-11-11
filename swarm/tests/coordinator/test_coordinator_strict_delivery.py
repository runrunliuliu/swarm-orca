"""Offline prepare -> fixed config delivery -> unchanged gated start integration."""

import copy
from contextlib import redirect_stdout
from datetime import timedelta
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from coordinator_io import file_ref, parse, pinned, publish_new, timestamp
from coordinator_launch import main
from coordinator_strict_delivery import MODE, deliver, delivery_plan, layout, wait_for_config
from coordinator_strict_start import wait_and_create
import coordinator.test_coordinator_strict_prepare as prepare_tests


class S5IntentReuseTests(unittest.TestCase):
    """Every S5 command re-enters the guard, so its own intent must be adoptable.

    Re-publishing it made the second invocation of any S5 command impossible once
    the first had admitted its intent (attempt20 `s5-deliver.json`, attempt22
    `s5-review.json`). Only the start time may differ; anything else is a different
    command and stays refused.
    """

    def value(self, **changes):
        base = dict(kind="strict_bootstrap_s5_intent", action="review", actor="operator",
                    control_id="ctl", generation="1",
                    request={"path": "/r.json", "sha256": "a" * 64},
                    association={"path": "/a.json", "sha256": "b" * 64},
                    execution_authorized=False)
        return dict(base, **changes)

    def test_the_same_command_is_adopted_across_start_times(self):
        from bootstrap_s5 import still_intent

        first, second = self.value(started_at="t1"), self.value(started_at="t2")
        self.assertTrue(still_intent({k: v for k, v in first.items() if k != "started_at"}, second))

    def test_a_different_action_request_or_control_is_not_the_same_intent(self):
        from bootstrap_s5 import still_intent

        expected = {k: v for k, v in self.value(started_at="t1").items() if k != "started_at"}
        for change in (dict(action="deliver"), dict(actor="coordinator"), dict(generation="2"),
                       dict(request={"path": "/other.json", "sha256": "a" * 64}),
                       dict(association={"path": "/a.json", "sha256": "c" * 64})):
            with self.subTest(change=change):
                self.assertFalse(still_intent(expected, self.value(started_at="t2", **change)))
        self.assertFalse(still_intent(expected, None))


class StrictDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.prep = prepare_tests.StrictPrepareTests()
        self.prep.setUp()
        self.addCleanup(self.prep.doCleanups)
        self.start, self.gate = self.prep.start, self.prep.gate
        self.bootstrap = self.prep.directory.parent
        self.directory = self.bootstrap / "strict-start"
        self.directory.mkdir(mode=0o700)
        self.start.directory = self.prep.directory = self.directory
        self.prep.input["directory"] = str(self.directory)
        self.prep.ref = self.gate.ref("prepare.json", self.prep.input)
        self.locations = layout(self.bootstrap)
        self.expected = {k: copy.deepcopy(self.prep.input[k]) for k in (
            "schema_version", "caller_receipt", "readiness_evidence", "directory",
            "objective", "max_workers", "deadline", "request_id")}
        self.expected.update(mode=MODE, **{k: copy.deepcopy(self.gate.contract[k])
            for k in ("cli", "runtime", "workspace", "coordinator")})
        self.ref = self.gate.ref("strict-config-request.json", self.expected, self.bootstrap)
        clock = patch("coordinator_strict_delivery.now", side_effect=lambda: self.start.clock.isoformat())
        clock.start()
        self.addCleanup(clock.stop)

    def prepare(self):
        self.result = self.prep.run_prepare()
        return self.result

    def publish(self):
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            return deliver(self.ref, self.result["config"], self.result["preparation"])

    def publication(self, **changes):
        value = {"schema_version": 1, "kind": "strict_start_config_publication",
                 "request": self.ref, "config": self.result["config"],
                 "preparation": self.result["preparation"], "published_at": self.start.clock.isoformat()}
        publish_new(Path(self.locations["publication_path"]), dict(value, **changes))

    def assert_no_start(self):
        self.assertEqual(self.start.creates(), [])
        self.assertEqual(self.gate.queries, [])
        self.assertFalse((self.directory / "ready.json").exists())
        self.assertFalse((self.directory / "gate-ready.json").exists())

    def test_plan_is_read_only_and_exact_even_before_prepare(self):
        result = delivery_plan(self.ref)
        self.assertEqual(result["publication_path"], self.locations["publication_path"])
        self.assertTrue(Path(result["wait_argv"][2]).is_absolute())
        self.assertNotIn("--execute", result["wait_argv"])
        self.assertEqual(self.start.calls, [])
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_transient_owner_busy_does_not_abort_the_publication_wait(self):
        # A live attempt aborted with "delivery failed" at S5 while the Operator
        # was still publishing, because one busy/timed-out checkpoint raised.
        from observation_budget import ObservationBusy
        state = {"calls": 0}

        def checkpoint_side_effect():
            state["calls"] += 1
            if state["calls"] <= 2:
                # ObservationTimeout shares the same transient handling but needs
                # a live budget scope, so the busy code stands in for both here.
                raise ObservationBusy()

        def later(seconds):
            self.start.clock += timedelta(seconds=seconds)
            if state["calls"] >= 2:
                self.prepare()
                self.publish()

        with patch("coordinator_strict_delivery.checkpoint", side_effect=checkpoint_side_effect), \
                patch("coordinator_strict_delivery.time.sleep", side_effect=later):
            result = wait_for_config(self.ref)
        self.assertTrue(result["review_required"])
        self.assertEqual(state["calls"], 3)
        self.assert_no_start()

    def test_delayed_prepare_delivery_returns_reviewable_plan_without_gate_or_create(self):
        sleeps = []

        def later(seconds):
            sleeps.append(seconds)
            self.start.clock += timedelta(seconds=seconds)
            if len(sleeps) == 3:
                self.prepare()
                self.publish()

        with patch("coordinator_strict_delivery.time.sleep", side_effect=later):
            result = wait_for_config(self.ref)
        self.assertEqual(len(sleeps), 3)
        self.assertTrue(result["review_required"])
        self.assertFalse(result["execution_authorized"])
        self.assertEqual(result["config"], self.result["config"])
        self.assert_no_start()
        self.assertTrue(all(q == ["orchestration", "strict-caller-check"] for q in self.start.calls))
        # Independent review then the existing waiter/gate is the ONLY creation path.
        self.start.ref = result["config"]
        self.assertTrue(wait_and_create(result["config"])["ok"])
        self.assertEqual(len(self.start.creates()), 1)

    def test_snapshot_mapping_accepts_original_path_change_after_freeze(self):
        self.prepare()
        config = parse(pinned(self.result["config"]))
        original = self.expected["readiness_evidence"][0]
        frozen = config["readiness_evidence"][0]
        self.assertNotEqual(original["path"], frozen["path"])
        self.assertEqual(original["sha256"], frozen["sha256"])
        Path(original["path"]).write_text("producer has moved on to another record")
        self.publish()
        self.assertTrue(wait_for_config(self.ref)["review_required"])
        self.assert_no_start()

    def test_duplicate_source_pins_share_one_verified_mapping(self):
        self.prep.input["readiness_evidence"] *= 2
        self.prep.ref = self.gate.ref("prepare.json", self.prep.input)
        self.prepare()
        self.publish()
        self.assertTrue(wait_for_config(self.ref)["ok"])
        self.assertEqual(len(parse(pinned(self.result["config"]))["readiness_evidence"]), 1)

    def test_unrelated_start_files_and_temporary_partial_files_do_not_wake(self):
        self.prepare()
        (self.bootstrap / ".strict-config-ready.json.partial").write_text('{"config":')
        self.gate.ref("start-other.json", parse(pinned(self.result["config"])), self.bootstrap)

        def later(seconds):
            self.start.clock += timedelta(seconds=seconds)
            self.publish()

        with patch("coordinator_strict_delivery.time.sleep", side_effect=later) as sleeper:
            self.assertTrue(wait_for_config(self.ref)["ok"])
        sleeper.assert_called_once()
        self.assert_no_start()

    def test_partial_exact_publication_fails_closed_without_retry(self):
        Path(self.locations["publication_path"]).write_text('{"config":')
        with patch("coordinator_strict_delivery.time.sleep") as sleeper:
            with self.assertRaises(ValueError):
                wait_for_config(self.ref)
        sleeper.assert_not_called()
        self.assert_no_start()

    def test_dangling_publication_is_not_absence(self):
        Path(self.locations["publication_path"]).symlink_to(self.bootstrap / "missing")
        with patch("coordinator_strict_delivery.time.sleep") as sleeper:
            with self.assertRaises(FileNotFoundError):
                wait_for_config(self.ref)
        sleeper.assert_not_called()
        self.assert_no_start()

    def test_deadline_and_monotonic_bound_never_refresh(self):
        def expire(_):
            self.start.clock = timestamp(self.expected["deadline"])
        with patch("coordinator_strict_delivery.time.sleep", side_effect=expire):
            with self.assertRaisesRegex(ValueError, "strict_config_wait_expired"):
                wait_for_config(self.ref)
        self.start.clock -= timedelta(seconds=2)
        with patch("coordinator_strict_delivery.time.monotonic", side_effect=[0, 3]):
            with self.assertRaisesRegex(ValueError, "strict_config_wait_expired"):
                wait_for_config(self.ref)
        self.assert_no_start()

    def test_changed_request_during_wait_is_not_repinned(self):
        def change(_):
            Path(self.ref["path"]).write_text("changed")
        with patch("coordinator_strict_delivery.time.sleep", side_effect=change):
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                wait_for_config(self.ref)
        self.assert_no_start()

    def test_wrong_caller_context_stops_before_wait(self):
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            with self.assertRaisesRegex(ValueError, "strict_coordinator_native_context_required"):
                wait_for_config(self.ref)
        self.assertEqual(self.start.calls, [])
        self.assert_no_start()

    def test_live_caller_change_after_delivery_stops(self):
        self.prepare()
        self.publish()
        query = self.start.query
        count = 0

        def changed(cli, runtime, args):
            nonlocal count
            proof = query(cli, runtime, args)
            count += 1
            if count == 2:
                proof["caller"]["processIncarnation"] = "different"
            return proof

        with patch("coordinator_strict_start.native", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "strict_launch_authority_changed"):
                wait_for_config(self.ref)
        self.assert_no_start()

    def test_a_registered_attempt_is_refused_before_the_review_work(self):
        """attempt18: preparation and review were spent, then the lifecycle was missing.

        The lifecycle requirement is unchanged; it must decide before the operator
        pays for preparation review, and the garbage refs below prove the ordering:
        they would raise their own pin errors if they were read first.
        """
        from bootstrap_s5 import current

        class Guard:
            def verify_read(self, ref):
                return None

        token = current.set(Guard())
        self.addCleanup(current.reset, token)
        missing = {"path": str(self.bootstrap / "absent.json"), "sha256": "0" * 64}
        with self.assertRaisesRegex(ValueError, "strict_lifecycle_required"):
            deliver(self.ref, missing, missing)
        self.assertFalse((self.bootstrap / "lifecycle").exists())

    def test_a_historical_unregistered_attempt_keeps_its_old_path(self):
        # No S5 guard is active, so the lifecycle stays optional exactly as before.
        self.prepare()
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            result = deliver(self.ref, self.result["config"], self.result["preparation"])
        self.assertTrue(result["ok"])
        self.assertFalse((self.bootstrap / "lifecycle").exists())

    def test_a_recorded_but_unwritten_publication_names_its_recovery(self):
        """attempt20 ended here with a generic delivery failure and no way to act.

        The owner records the publication intent before writing it; when the write
        did not happen the operator must be told to reconcile that entry, while the
        publication stays unpublishable by any other route.
        """
        self.prepare()
        with patch("coordinator_strict_delivery.publish_new",
                   side_effect=ValueError("bootstrap_commit_requires_reconciliation")), \
                patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            with self.assertRaisesRegex(ValueError, "strict_config_publication_requires_reconcile"):
                deliver(self.ref, self.result["config"], self.result["preparation"])
        self.assertFalse(Path(self.locations["publication_path"]).exists())
        self.assert_no_start()

    def test_publication_wrong_request_is_rejected(self):
        self.prepare()
        self.publication(request=dict(self.ref, sha256="0" * 64))
        with self.assertRaisesRegex(ValueError, "strict_config_publication_mismatch"):
            wait_for_config(self.ref)
        self.assert_no_start()

    def test_manifest_command_is_rejected_not_executed(self):
        self.prepare()
        self.publication(command="not executed")
        with self.assertRaisesRegex(ValueError, "strict_config_publication_mismatch"):
            wait_for_config(self.ref)
        self.assert_no_start()

    def test_receiver_checks_bindings_independently_of_publisher(self):
        self.prepare()
        # A valid preparation is not sufficient if it belongs to different expectations.
        variants = [("runtime", "other"), ("request_id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
                    ("max_workers", 99), ("objective", "other"),
                    ("workspace", dict(self.expected["workspace"], id="other")),
                    ("coordinator", dict(self.expected["coordinator"], session="other")),
                    ("readiness_evidence", [dict(self.expected["readiness_evidence"][0],
                                                 path=str(self.bootstrap / "same-hash-wrong-source"))])]
        self.publication()
        for key, value in variants:
            changed = dict(self.expected, **{key: value})
            changed_ref = self.gate.ref("strict-config-request.json", changed, self.bootstrap)
            # Matching manifest pin alone still cannot bless a mismatched preparation.
            from coordinator_strict_delivery import prepared
            with self.subTest(key=key), self.assertRaises(ValueError):
                prepared(changed_ref, self.result["config"], self.result["preparation"])
        self.assert_no_start()

    def test_mapping_tamper_rejected_even_with_new_receipt_pin(self):
        self.prepare()
        receipt = parse(pinned(self.result["preparation"]))
        receipt["readiness_snapshots"][0]["source"]["path"] = str(self.bootstrap / "wrong-source")
        self.result["preparation"] = self.gate.ref("prepared-inputs.json", receipt, self.directory)
        self.publication()
        with self.assertRaisesRegex(ValueError, "snapshot_mapping_mismatch"):
            wait_for_config(self.ref)
        self.assert_no_start()

    def test_snapshot_tamper_rejected(self):
        self.prepare()
        self.publish()
        config = parse(pinned(self.result["config"]))
        Path(config["readiness_evidence"][0]["path"]).write_text("tampered")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            wait_for_config(self.ref)
        self.assert_no_start()

    def test_duplicate_publish_never_overwrites_and_wrong_operator_never_writes(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError, "operator_native_context_mismatch"):
            deliver(self.ref, self.result["config"], self.result["preparation"])
        self.assertFalse(Path(self.locations["publication_path"]).exists())
        ref = self.publish()["publication"]
        with self.assertRaises(FileExistsError):
            self.publish()
        pinned(ref)
        self.assert_no_start()

    def test_config_pin_tamper_rejected(self):
        self.prepare()
        self.publish()
        Path(self.result["config"]["path"]).write_text("changed")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            wait_for_config(self.ref)
        self.assert_no_start()

    def test_same_hash_snapshot_at_unmapped_path_is_not_accepted(self):
        self.prepare()
        config = parse(pinned(self.result["config"]))
        receipt = parse(pinned(self.result["preparation"]))
        old = config["readiness_evidence"][0]
        new_path = self.directory / "arbitrary-same-content.snapshot"
        publish_new(new_path, pinned(old))
        new = file_ref(new_path)
        contract = parse(pinned(config["contract"]))
        contract["skill_read_evidence"] = new
        config["contract"] = self.gate.ref("session-contract.json", contract, self.directory)
        config["readiness_evidence"] = [new]
        receipt["contract"] = config["contract"]
        receipt["readiness_snapshots"][0]["snapshot"] = new
        self.result["config"] = self.gate.ref("start.json", config, self.directory)
        self.result["preparation"] = self.gate.ref("prepared-inputs.json", receipt, self.directory)
        self.publication()
        with self.assertRaisesRegex(ValueError, "snapshot_mapping_mismatch"):
            wait_for_config(self.ref)
        self.assert_no_start()

    def test_publication_permission_denial_stops_without_polling(self):
        original = Path.lstat

        def deny(target):
            if str(target) == self.locations["publication_path"]:
                raise PermissionError("denied")
            return original(target)

        with patch.object(Path, "lstat", deny), patch("coordinator_strict_delivery.time.sleep") as sleeper:
            with self.assertRaises(PermissionError):
                wait_for_config(self.ref)
        sleeper.assert_not_called()
        self.assert_no_start()

    def test_future_publication_is_rejected(self):
        self.prepare()
        self.publication(published_at=(self.start.clock + timedelta(seconds=1)).isoformat())
        with self.assertRaisesRegex(ValueError, "strict_config_time_invalid"):
            wait_for_config(self.ref)
        self.assert_no_start()

    def test_consumed_attempt_stops_even_after_expiry(self):
        publish_new(self.directory / "create-intent.json", {"unknown": True})
        self.start.clock = timestamp(self.expected["deadline"])
        for operation in (delivery_plan, wait_for_config):
            with self.assertRaisesRegex(ValueError, "create_requires_reconciliation"):
                operation(self.ref)
        self.assertEqual(self.start.calls, [])

    def test_cli_explicit_publish_and_read_only_receiver(self):
        for mode, flags, expected in (
            ("strict-config-publish", [], "strict_config_explicit_execute_required"),
            ("strict-config-wait", ["--execute"], "strict_config_receiver_is_read_only"),
            ("strict-config-plan", [], None)):
            out = io.StringIO()
            with redirect_stdout(out):
                status = main([mode, "--request", self.ref["path"], "--request-sha256",
                               self.ref["sha256"], *flags])
            self.assertEqual(status, 2 if expected else 0)
            if expected:
                self.assertEqual(json.loads(out.getvalue())["error"], expected)
        self.assert_no_start()

    def test_real_cli_publish_and_receive(self):
        self.prepare()
        flags = ["--request", self.ref["path"], "--request-sha256", self.ref["sha256"]]
        for mode in ("strict-config-publish", "strict-config-wait"):
            extra = []
            if mode.endswith("publish"):
                extra = ["--config", self.result["config"]["path"], "--config-sha256",
                         self.result["config"]["sha256"], "--preparation", self.result["preparation"]["path"],
                         "--preparation-sha256", self.result["preparation"]["sha256"], "--execute"]
            out = io.StringIO()
            terminal = "term_operator" if extra else "term_test"
            with redirect_stdout(out), patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": terminal}):
                self.assertEqual(main([mode, *flags, *extra]), 0)
            self.assertTrue(json.loads(out.getvalue())["ok"])
        self.assert_no_start()


if __name__ == "__main__":
    unittest.main()
