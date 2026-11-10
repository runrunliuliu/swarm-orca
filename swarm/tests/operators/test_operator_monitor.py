"""Offline monitor protocol tests; no live Run, model or platform side effects."""

from contextlib import redirect_stdout
import copy
from datetime import timedelta
import io
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from coordinator_io import (bound_lock, file_ref, now, publish_new, read_json, replace_json,
                            timestamp)
import operator_monitor as monitor
import progress_watch as watch


class MonitorTests(unittest.TestCase):
    def test_busy_is_unavailable_without_identity_retry_or_stop_latch(self):
        from observation_budget import ObservationBusy
        with patch.object(monitor, "tick", side_effect=ObservationBusy()) as tick, redirect_stdout(io.StringIO()):
            self.assertEqual(monitor.run(self.config), 3)
        self.assertEqual(tick.call_count, 1)
        self.assertEqual(read_json(self.state_root / "status.json")["state"], "observation_unavailable")
        self.assertFalse(monitor.failure_latch(self.config).exists())
        self.assertFalse(self.messages)

    def test_typed_revalidation_recovers_without_stop_or_send_while_pending(self):
        from bootstrap_identity import IdentityVerificationPending
        ticks, events = [], []
        def tick(config):
            ticks.append(True)
            if len(ticks) == 1:
                self.assertFalse(self.messages)
                raise IdentityVerificationPending("bootstrap_identity_reverification_pending")
            self.assertEqual(read_json(self.state_root / "status.json")["state"], "revalidation_pending")
            self.assertFalse(monitor.failure_latch(config).exists())
            result = real_tick(config, call=self.fake)
            signal.raise_signal(signal.SIGTERM)
            return result
        real_tick = monitor.tick
        with patch.object(monitor, "tick", side_effect=tick), \
                patch("threading.Event.wait", return_value=False), redirect_stdout(io.StringIO()):
            result = monitor.run(self.config, observer=lambda *event: events.append(event))
        self.assertEqual(result, 0)
        self.assertEqual(len(ticks), 2)
        self.assertEqual(len(self.messages), 1)
        self.assertIn(("pending", None), events)
        self.assertFalse(monitor.failure_latch(self.config).exists())

    def test_typed_pending_is_bounded_and_generic_errors_remain_hard_stop(self):
        from bootstrap_identity import IdentityVerificationPending
        with patch.object(monitor, "tick", side_effect=IdentityVerificationPending("bootstrap_identity_reverification_pending")) as tick, \
                patch("threading.Event.wait", return_value=False), redirect_stdout(io.StringIO()):
            self.assertEqual(monitor.run(self.config), 3)
        self.assertEqual(tick.call_count, 3)
        self.assertFalse(monitor.failure_latch(self.config).exists())
        self.assertFalse(self.messages)
        with patch.object(monitor, "tick", side_effect=PermissionError("denied")) as tick, redirect_stdout(io.StringIO()):
            self.assertEqual(monitor.run(self.config), 2)
        self.assertEqual(tick.call_count, 1)
        self.assertTrue(monitor.failure_latch(self.config).exists())

    def test_pending_never_clears_existing_stop(self):
        from bootstrap_identity import IdentityVerificationPending
        latch = monitor.failure_latch(self.config)
        publish_new(latch, {"reason": "original_stop"})
        original = latch.read_bytes()
        with patch.object(monitor, "tick", side_effect=IdentityVerificationPending("bootstrap_identity_reverification_pending")), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(monitor.run(self.config), 2)
        self.assertEqual(latch.read_bytes(), original)
        self.assertFalse(self.messages)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.state_root = self.root / "state"
        self.state_root.mkdir(mode=0o700)
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir()
        self.binding = dict(runtime="runtime-test", run="run_test", workspace="repo::/work",
                            terminal="term-coord", incarnation="inc-coord", generation=2)
        self.terminal = dict(handle="term-coord", incarnationId="inc-coord", worktreeId="repo::/work",
                             connected=True, orphaned=False)
        self.run = dict(id="run_test", consumer_generation=2, coordinator_handle="term-coord")
        self.manifest = dict(schema_version=1, binding=self.binding, jobs={}, artifacts=[])
        self.watch_file = self.root / "watch.json"
        publish_new(self.watch_file, self.manifest)
        self.adapter = self.root / "adapter.py"
        publish_new(self.adapter, b'import json,sys\nr=json.load(sys.stdin)\n'
                    b'assert r["method"] == "query"\n'
                    b'print(json.dumps(dict(operation_key=r["operation_key"],job=r["job"],'
                    b'status="running",evidence={"checkpoint":"one"})))\n')
        self.sender = dict(terminal="term-operator", incarnation="inc-operator", workspace="repo::/operator")
        self.operator_terminal = dict(handle="term-operator", incarnationId="inc-operator", worktreeId="repo::/operator",
                                      tabId="operator-tab", leafId="operator-leaf", connected=True, orphaned=False,
                                      agentIdentity=None)
        self.environment = dict(ORCA_TERMINAL_HANDLE="term-operator", ORCA_PANE_KEY="operator-tab:operator-leaf")
        env = patch.dict(os.environ, self.environment, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.data = dict(schema_version=2, enabled=True, binding=self.binding, sender=self.sender, continuation=None,
                         operator_id="operator-monitor:test", state_root=str(self.state_root),
                         watch_file=str(self.watch_file), artifact_roots=[str(self.artifacts)],
                         adapters={"test": file_ref(self.adapter)}, poll_seconds=1,
                         rpc_timeout_seconds=1, idle_seconds=10, inbox_limit=100)
        self.config_file = self.root / "config.json"
        self.config = self.configure()
        self.calls, self.messages, self.receipts = [], [], {}
        self.tasks = []

    def configure(self):
        replace_json(self.config_file, self.data)
        return monitor.Config(str(self.config_file), file_ref(self.config_file)["sha256"])

    def state(self):
        return read_json(self.state_root / "state.json")

    def event(self):
        return read_json(self.state()["outbox"][-1]["event"]["path"])

    def fake(self, args, runtime, timeout=12):
        self.assertEqual(runtime, self.binding["runtime"])
        self.calls.append(args)
        if args == ["status"]:
            return {}
        method = args[1]
        if method == "run-show":
            return dict(run=copy.deepcopy(self.run), coordinatorPolicy="strict-v1")
        if method == "show":
            return dict(terminal=copy.deepcopy(self.operator_terminal if args[-1] == "term-operator" else self.terminal))
        if method == "list":
            return dict(terminals=[copy.deepcopy(self.terminal)], truncated=False)
        if method == "worker-list":
            return dict(scope=dict(run="run_test"), workers=[],
                        page=dict(total=0, hasMore=False, nextCursor=None))
        if method == "task-list":
            return dict(runId="run_test", tasks=self.tasks, count=len(self.tasks))
        if method == "send":
            self.assertNotIn("--from", args)
            self.assertEqual(args[args.index("--to") + 1], "run:run_test")
            self.assertEqual(args[args.index("--type") + 1], "status")
            key = args[args.index("--retry-request") + 1]
            self.assertNotIn(key, self.receipts, "monitor must reconcile, not repeat send")
            message = dict(id="msg-" + key, run_id="run_test", from_handle="term-operator",
                           to_handle="run:run_test", read=0, delivery_contract="current_delivery")
            if "--payload" in args:
                message["payload"] = args[args.index("--payload") + 1]
            reply = dict(message=message, mutation=dict(requestId=key))
            self.messages.append(message)
            self.receipts[key] = copy.deepcopy(reply)
            return copy.deepcopy(reply)
        if method == "request-show":
            key = args[args.index("--request") + 1]
            if key not in self.receipts:
                return dict(requestId=key, state="absent")
            return dict(requestId=key, state="completed", method="orchestration.send", receipt=self.receipts[key])
        if method == "inbox":
            if "--pending" in args:
                terminal = args[args.index("--terminal") + 1]
                rows = [m for m in self.messages if m["to_handle"] == terminal and m["read"] == 0
                        and m.get("delivery_contract") == "current_delivery"]
                rows = rows[:int(args[args.index("--limit") + 1])]
                return dict(messages=copy.deepcopy(rows), count=len(rows),
                            filter=dict(mode="pending", terminal=terminal, deliveryContract="current_delivery"))
            return dict(messages=copy.deepcopy(self.messages), count=len(self.messages))
        self.fail("Unexpected native verb: " + str(args))

    def tick(self, **kwargs):
        return monitor.tick(self.config, call=kwargs.pop("call", self.fake), **kwargs)

    def register_job(self, key="a" * 64, job="job-one"):
        request = self.root / (key + ".json")
        publish_new(request, dict(schema_version=1, binding=self.binding, method="query",
                                  operation_key=key, job=job))
        self.manifest["jobs"][key] = dict(adapter="test", request=file_ref(request))
        replace_json(self.watch_file, self.manifest)

    def cli(self, *args):
        with patch.dict(os.environ, self.environment, clear=True), patch.object(monitor, "native", self.fake), redirect_stdout(io.StringIO()):
            # tick's dependency defaults are intentional; patch the boundary for CLI tests.
            original = monitor.tick
            with patch.object(monitor, "tick", side_effect=lambda config: original(config, call=self.fake)):
                return monitor.main(["--config", str(self.config_file), "--config-sha256",
                                     self.config.ref["sha256"], *args])

    def test_persistent_idle_monitor_and_restart_do_not_resend(self):
        for _ in range(3):
            self.assertEqual(self.tick(), "monitoring")
            self.config = monitor.Config(str(self.config_file), self.config.ref["sha256"])
        self.assertEqual(len(self.messages), 1)
        self.assertEqual(self.state()["sequence"], 1)
        self.assertEqual(read_json(self.state_root / "status.json")["state"], "monitoring")
        self.assertNotIn("check", [args[1] for args in self.calls if len(args) > 1])
        self.assertNotIn("ack", str(self.calls))

    def test_native_read_is_not_business_processing_or_completion(self):
        self.tasks = [dict(id="task-one", status="completed")]
        self.tick()
        self.messages[0]["read"] = 1
        self.tick()
        delivery = self.state()["outbox"][0]["delivery"]
        self.assertTrue(delivery["native_read"])
        self.assertEqual(delivery["business_processed"], "unknown")
        self.assertEqual(self.event()["business_acceptance"], "not_evaluated")
        self.assertEqual(len(self.messages), 1)

    def test_missing_history_is_unknown_not_acknowledged_or_resent(self):
        self.tick()
        self.messages.clear()
        self.tick()
        self.assertIsNone(self.state()["outbox"][0]["delivery"]["native_read"])
        self.assertEqual(len(self.receipts), 1)

    def test_invalid_read_markers_are_unknown_and_confirmed_read_is_sticky(self):
        self.tick()
        for read in (2, -1, "1", True, None):
            self.messages[0]["read"] = read
            self.tick()
            self.assertIsNone(self.state()["outbox"][0]["delivery"]["native_read"])
        self.messages[0]["read"] = 1
        self.tick()
        self.messages.clear()
        self.tick()
        self.assertTrue(self.state()["outbox"][0]["delivery"]["native_read"])
        self.assertEqual(len(self.receipts), 1)

    def test_worker_pagination_and_state_changes_reuse_collector(self):
        def pages(args, *rest):
            reply = self.fake(args, *rest)
            if args[1:2] == ["worker-list"]:
                second = "--cursor" in args
                reply.update(workers=[dict(dispatchId="d2" if second else "d1", workerState="completed")],
                             page=dict(total=2, hasMore=not second, nextCursor=None if second else "next"))
            return reply
        self.tick(call=pages)
        self.assertEqual(len(self.event()["facts"]["workers"]), 2)
        self.assertEqual(self.event()["business_acceptance"], "not_evaluated")

    def test_jobs_added_later_are_queried_including_after_manifest_removal(self):
        self.tick()
        self.register_job()
        self.register_job("b" * 64, "job-two")
        self.tick()  # Real isolated pinned adapter subprocesses.
        self.assertEqual(len(self.event()["facts"]["jobs"]), 2)
        self.manifest["jobs"] = {}
        replace_json(self.watch_file, self.manifest)
        self.tick()
        self.assertEqual(len(self.state()["jobs"]), 2)
        self.assertEqual(len(self.messages), 2)

    def test_same_running_job_new_checkpoint_and_late_artifact_emit_events(self):
        self.register_job()
        artifact = self.artifacts / "checkpoint.ready"
        self.manifest["artifacts"] = [str(artifact)]
        replace_json(self.watch_file, self.manifest)
        self.tick()
        publish_new(artifact, {"checkpoint": "two"})
        self.tick()
        def query(ref, request, **kwargs):
            self.assertEqual(request["method"], "query")
            return dict(operation_key=request["operation_key"], job=request["job"], status="running",
                        evidence={"checkpoint": "two"})
        self.tick(invoke=query)
        self.assertEqual(len(self.messages), 3)
        self.assertEqual(self.event()["facts"]["jobs"]["a" * 64]["status"], "running")

    def test_job_timeout_is_unknown_and_monitor_continues_without_submit(self):
        self.register_job()
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired("query", 1)
        self.assertEqual(self.tick(invoke=timeout), "monitoring")
        self.assertEqual(self.event()["facts"]["jobs"]["a" * 64]["status"], "unknown")
        self.assertEqual(self.tick(), "monitoring")

    def test_idle_timeout_event_is_deduplicated_and_cleared_on_progress(self):
        self.tick()
        state = self.state()
        state["last_progress_at"] = (timestamp(now()) - timedelta(seconds=20)).isoformat()
        replace_json(self.state_root / "state.json", state)
        self.tick()
        self.assertTrue(self.event()["idle_timeout"])
        self.tick()
        self.assertEqual(len(self.messages), 2)
        self.tasks = [dict(id="task-one", status="dispatched")]
        self.tick()
        self.assertFalse(self.event()["idle_timeout"])

    def test_crash_after_enqueue_recovers_receipt_without_send(self):
        def crash(args, *rest):
            result = self.fake(args, *rest)
            if args[1:2] == ["send"]:
                raise KeyboardInterrupt()
            return result
        with self.assertRaises(KeyboardInterrupt):
            self.tick(call=crash)
        self.assertTrue(self.state()["outbox"][0]["attempted"])
        self.assertIsNone(self.state()["outbox"][0]["delivery"])
        self.tick()
        self.assertEqual(len(self.messages), 1)
        self.assertIsNotNone(self.state()["outbox"][0]["delivery"])

    def test_signal_during_send_drains_receipt_and_restart_does_not_resend(self):
        original = self.fake
        def stop_during_send(args, *rest):
            reply = original(args, *rest)
            if args[1:2] == ["send"]:
                # Attempt was persisted before native I/O; receipt is not yet saved.
                entry = self.state()["outbox"][0]
                self.assertTrue(entry["attempted"])
                self.assertIsNone(entry["delivery"])
                signal.raise_signal(signal.SIGINT)
            return reply
        self.fake = stop_during_send
        previous = signal.getsignal(signal.SIGINT)
        self.assertEqual(self.cli("--execute", "--confirm-skill-read"), 0)
        self.assertEqual(signal.getsignal(signal.SIGINT), previous)
        delivery = self.state()["outbox"][0]["delivery"]
        self.assertEqual(delivery["message_id"], self.messages[0]["id"])
        self.assertFalse((self.state_root / "monitor-stop.json").exists())
        self.fake = original
        self.assertEqual(self.cli("--execute", "--confirm-skill-read", "--once"), 0)
        self.assertEqual(self.state()["outbox"][0]["delivery"], delivery)
        self.assertEqual(len(self.messages), 1)

    def test_absent_uncertain_send_never_retries(self):
        def crash(args, *rest):
            if args[1:2] == ["send"]:
                raise KeyboardInterrupt()
            return self.fake(args, *rest)
        with self.assertRaises(KeyboardInterrupt):
            self.tick(call=crash)
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
                self.tick()
        self.assertEqual(self.messages, [])

    def test_identity_changes_before_send_are_fenced(self):
        def changed(args, *rest):
            reply = self.fake(args, *rest)
            if args[1:2] == ["list"]:
                self.run["consumer_generation"] += 1
            return reply
        with self.assertRaisesRegex(ValueError, "coordinator_changed"):
            self.tick(call=changed)
        self.assertEqual(self.messages, [])

    def test_unverifiable_coordinator_and_non_strict_run_refused(self):
        self.terminal["connected"] = False
        with self.assertRaisesRegex(ValueError, "unverifiable"):
            self.tick()
        self.terminal["connected"] = True
        def ordinary(args, *rest):
            result = self.fake(args, *rest)
            if args[1:2] == ["run-show"]:
                result["coordinatorPolicy"] = None
            return result
        with self.assertRaisesRegex(ValueError, "coordinator_changed"):
            self.tick(call=ordinary)
        self.assertEqual(self.messages, [])

    def test_manifest_cannot_execute_or_change_job_identity(self):
        self.register_job()
        request = self.root / ("a" * 64 + ".json")
        payload = read_json(request)
        payload["method"] = "execute"
        replace_json(request, payload)
        self.manifest["jobs"]["a" * 64]["request"] = file_ref(request)
        replace_json(self.watch_file, self.manifest)
        with self.assertRaisesRegex(ValueError, "query_binding_mismatch"):
            self.tick()
        self.assertEqual(self.messages, [])

    def test_historical_requests_are_revalidated_before_adapter_invocation(self):
        self.register_job()
        self.tick()
        self.manifest["jobs"] = {}
        replace_json(self.watch_file, self.manifest)
        state = self.state()
        request = self.root / "corrupted-request.json"
        publish_new(request, dict(method="execute", operation_key="a" * 64,
                                  binding=self.binding, job="job-one"))
        state["jobs"]["a" * 64]["request"] = file_ref(request)
        replace_json(self.state_root / "state.json", state)
        with patch.object(monitor.operator, "invoke") as invoke:
            with self.assertRaisesRegex(ValueError, "query_binding_mismatch"):
                self.tick(invoke=invoke)
            invoke.assert_not_called()

    def test_outside_scope_and_symlink_artifacts_refused(self):
        for filename in (str(self.root / "secret"), str(self.artifacts / "link")):
            if filename.endswith("link"):
                Path(filename).symlink_to(self.config_file)
            self.manifest["artifacts"] = [filename]
            replace_json(self.watch_file, self.manifest)
            with self.assertRaisesRegex(ValueError, "artifact_outside_scope"):
                self.tick()

    def test_config_change_and_multiple_writers_refused(self):
        with bound_lock(self.state_root, self.config.ref, "monitor"):
            with self.assertRaises(BlockingIOError), bound_lock(self.state_root, self.config.ref, "monitor"):
                self.fail("second writer")
        self.data["idle_seconds"] = 30
        other = self.configure()
        with self.assertRaisesRegex(ValueError, "monitor_config_changed"), bound_lock(self.state_root, other.ref, "monitor"):
            self.fail("changed config")

    def test_cli_second_monitor_is_rejected_without_touching_owner_state(self):
        with bound_lock(self.state_root, self.config.ref, "monitor"):
            with self.assertRaises(BlockingIOError):
                self.cli("--execute", "--confirm-skill-read", "--once")
        self.assertEqual(self.calls, [])
        self.assertFalse((self.state_root / "monitor-stop.json").exists())
        self.assertFalse((self.state_root / "state.json").exists())

    def test_cli_validation_has_no_queries_or_state_and_execute_is_opt_in(self):
        self.assertEqual(self.cli(), 0)
        self.assertFalse((self.state_root / "state.json").exists())
        self.assertEqual(self.calls, [])
        with self.assertRaisesRegex(ValueError, "not_enabled"):
            self.cli("--execute", "--once")
        self.assertEqual(self.cli("--execute", "--confirm-skill-read", "--once"), 0)

    def test_cli_loops_until_signal_and_persists_stop_on_native_failure(self):
        original = self.fake
        def signal_after_second(args, *rest):
            reply = original(args, *rest)
            if args[1:2] == ["inbox"] and len([c for c in self.calls if c[1:2] == ["inbox"]]) == 2:
                signal.raise_signal(signal.SIGTERM)
            return reply
        self.fake = signal_after_second
        self.assertEqual(self.cli("--execute", "--confirm-skill-read"), 0)
        self.assertEqual(len(self.messages), 1)
        self.fake = lambda *args: (_ for _ in ()).throw(watch.StopObservation("runtime_access_denied"))
        self.assertEqual(self.cli("--execute", "--confirm-skill-read", "--once"), 2)
        self.assertTrue((self.state_root / "monitor-stop.json").exists())
        self.fake = original
        before = len(self.calls)
        self.assertEqual(self.cli("--execute", "--confirm-skill-read", "--once"), 2)
        self.assertEqual(len(self.calls), before)

    def test_manual_stop_never_queries(self):
        publish_new(self.state_root / "STOP", {})
        self.assertEqual(self.tick(), "monitor_stopped")
        self.assertEqual(self.calls, [])

    def test_legacy_config_is_readable_but_cannot_send_as_audit_label(self):
        self.data["schema_version"] = 1
        self.data.pop("sender")
        self.data.pop("continuation")
        self.config = self.configure()
        self.assertEqual(self.cli(), 0)
        with self.assertRaisesRegex(ValueError, "native_sender_configuration_required"):
            self.cli("--execute", "--confirm-skill-read", "--once")
        self.assertEqual(self.calls, [])

    def test_native_operator_environment_is_required_without_spoofing(self):
        for environment in ({}, {"ORCA_AGENT_SESSION_ID": "worker"}):
            with patch.dict(os.environ, environment, clear=not environment):
                with self.assertRaisesRegex(ValueError, "own_operator_terminal"):
                    self.tick()
        self.operator_terminal["agentIdentity"] = "trae"
        with self.assertRaisesRegex(ValueError, "operator_terminal_unverifiable"):
            self.tick()
        self.assertEqual(self.messages, [])


if __name__ == "__main__":
    unittest.main()
