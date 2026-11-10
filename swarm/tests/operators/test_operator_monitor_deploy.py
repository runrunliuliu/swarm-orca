"""Deployment proof tests: mocked native state is NOT live acceptance."""
from contextlib import redirect_stdout
from datetime import timedelta
import io
import errno
import fcntl
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from coordinator_io import bound_lock, file_ref, now, publish_new, read_json, replace_json, timestamp
import operator_monitor as monitor
import operator_monitor_deploy as deploy
import coordinator.test_coordinator_tui_scheduler as scheduler


class MonitorLockTests(unittest.TestCase):
    def setUp(self):
        # TMPDIR can select the real NFS mount without touching a live lock/state.
        temporary = tempfile.TemporaryDirectory(prefix="monitor-lock-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.config = SimpleNamespace(root=self.root, ref={"test": "monitor-lock"})

    def test_held_lock_uses_writable_descriptor_without_changing_files(self):
        flock = fcntl.flock
        def nfs_lock(fd, operation):
            if fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY:
                raise OSError(errno.EBADF, "NFS exclusive lock needs write access")
            return flock(fd, operation)
        with bound_lock(self.root, self.config.ref, "monitor"):
            before = {p.name: file_ref(p) for p in self.root.iterdir()}
            with patch.object(deploy.fcntl, "flock", side_effect=nfs_lock):
                deploy.locked_monitor(self.config)
            self.assertEqual(before, {p.name: file_ref(p) for p in self.root.iterdir()})
        with self.assertRaisesRegex(ValueError, "lock_not_held"):
            deploy.locked_monitor(self.config)
        with bound_lock(self.root, self.config.ref, "monitor"):
            pass  # The inspector released its descriptor/temporary lock.

    def test_missing_lock_not_created(self):
        publish_new(self.root / "monitor-binding.json", self.config.ref)
        with self.assertRaises(FileNotFoundError):
            deploy.locked_monitor(self.config)
        self.assertFalse((self.root / "monitor.lock").exists())

    def test_lock_errors_are_not_treated_as_contention(self):
        with bound_lock(self.root, self.config.ref, "monitor"):
            for code in (errno.EACCES, errno.EPERM, errno.EBADF, errno.EIO):
                with self.subTest(code=code), patch.object(deploy.fcntl, "flock", side_effect=OSError(code, "error")):
                    with self.assertRaises(OSError) as caught:
                        deploy.locked_monitor(self.config)
                    self.assertEqual(caught.exception.errno, code)

    def test_symlink_and_invalid_mode_refused(self):
        publish_new(self.root / "monitor-binding.json", self.config.ref)
        target = self.root / "other"
        publish_new(target, b"")
        (self.root / "monitor.lock").symlink_to(target)
        with self.assertRaises(OSError):
            deploy.locked_monitor(self.config)
        (self.root / "monitor.lock").unlink()
        publish_new(self.root / "monitor.lock", b"")
        (self.root / "monitor.lock").chmod(0o644)
        with self.assertRaisesRegex(ValueError, "invalid_lock_file"):
            deploy.locked_monitor(self.config)


class DeploymentTests(unittest.TestCase):
    mode = "host-process"

    def setUp(self):
        self.s = scheduler.SchedulerTests()
        self.s.setUp()
        self.addCleanup(self.s.doCleanups)
        self.m, self.f = self.s.m, self.s.f
        self.output = self.m.root / "deployment"
        self.output.mkdir(mode=0o700)
        self.ref = deploy.prepare(self.f.config_ref, str(self.m.state_root), str(self.output),
                                  verification_mode=self.mode, call=self.m.fake)
        self.plan, self.config = deploy.validate(self.ref)
        self.identity = dict(pid=os.getpid(), boot_id="boot", start_ticks="123", executable="python", argv_sha256="a" * 64)

    def execute(self, *, tick=None, observer=None):
        original, replace = monitor.tick, deploy.replace_json
        def write(target, data):
            replace(target, data)
            if observer and target.name == "deployment-status.json" and data["phase"] == "monitoring":
                observer()
        with patch.object(monitor, "tick", side_effect=tick or (lambda c: original(c, call=self.m.fake))), \
                patch("coordinator_tui_scheduler.schedule", side_effect=lambda *_: self.s.tick()), \
                patch.object(deploy, "process_identity", return_value=self.identity), \
                patch.object(deploy, "process_environment", return_value=self.m.environment), \
                patch.object(deploy, "replace_json", side_effect=write), redirect_stdout(io.StringIO()):
            return deploy.run(self.ref, once=True)

    def test_prepare_observes_sender_and_derives_binding(self):
        self.assertEqual(self.config.data["binding"], self.m.binding)
        self.assertEqual(self.config.data["sender"], self.m.sender)
        self.assertEqual(self.config.data["rpc_timeout_seconds"], 20)
        self.assertEqual(list(self.m.state_root.iterdir()), [])
        self.assertEqual(self.m.calls, [["terminal", "show", "--terminal", "term-operator"]] * 2)
        with self.assertRaisesRegex(ValueError, "fresh_directories"):
            deploy.prepare(self.f.config_ref, str(self.m.state_root), str(self.output))

    def test_bad_limits_publish_nothing(self):
        target = self.m.root / "invalid"
        target.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, "invalid_monitor_limits"):
            deploy.prepare(self.f.config_ref, str(self.m.state_root), str(target), poll_seconds=0)
        self.assertEqual(list(target.iterdir()), [])

    def test_agent_sender_and_final_identity_race_refuse_publication(self):
        for fail_on in (1, 2):
            with self.subTest(fail_on=fail_on):
                target = self.m.root / ("sender-race-" + str(fail_on))
                target.mkdir(mode=0o700)
                calls = []
                def changed(args, runtime, timeout):
                    result = self.m.fake(args, runtime, timeout)
                    calls.append(args)
                    if len(calls) == fail_on:
                        result["terminal"]["agentIdentity"] = "trae"
                    return result
                with self.assertRaisesRegex(ValueError, "operator_terminal_unverifiable"):
                    deploy.prepare(self.f.config_ref, str(self.m.state_root), str(target), call=changed)
                self.assertFalse((target / "deployment.json").exists())
                if fail_on == 1:
                    self.assertEqual(list(target.iterdir()), [])

    def test_native_1219_shell_omits_optional_agent_identity(self):
        self.m.operator_terminal.pop("agentIdentity")
        target = self.m.root / "native-shell"
        target.mkdir(mode=0o700)
        ref = deploy.prepare(self.f.config_ref, str(self.m.state_root), str(target), call=self.m.fake)
        _, config = deploy.validate(ref)
        monitor.sender_fence(config, lambda args, runtime: self.m.fake(args, runtime),
                             environment=self.m.environment)

    def test_missing_head_fails_before_native(self):
        self.m.calls.clear()
        self.f.config["checkpoint_head"] = str(self.m.root / "missing")
        ref = self.f.t.ref("missing-deployment.json", self.f.config)
        with self.assertRaisesRegex(ValueError, "head_not_initialized"):
            deploy.prepare(ref, str(self.m.state_root), str(self.output))
        self.assertEqual(self.m.calls, [])

    def test_changed_source_rejected(self):
        with patch.object(deploy, "sources", return_value=[]):
            with self.assertRaisesRegex(ValueError, "source_changed"):
                deploy.run(self.ref, once=True)
        self.assertFalse((self.m.state_root / "state.json").exists())

    def test_changed_config_rejected(self):
        data = read_json(self.plan["config"]["path"])
        data["poll_seconds"] += 1
        replace_json(self.output / "monitor.json", data)
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            deploy.run(self.ref, once=True)

    def test_active_requires_first_tick_and_exit_is_not_active(self):
        proofs = []
        self.assertEqual(self.execute(observer=lambda: proofs.append(deploy.verify(self.ref, call=self.m.fake))), 0)
        self.assertEqual(proofs[0]["state"], "monitor_active")
        self.assertEqual(proofs[0]["business_acceptance"], "not_evaluated")
        self.assertEqual(len(self.m.messages), 1)
        self.assertEqual(read_json(self.m.state_root / "deployment-status.json")["phase"], "exited")
        with self.assertRaisesRegex(ValueError, "not_active"):
            deploy.verify(self.ref, call=self.m.fake)

    def test_restart_deduplication(self):
        self.assertEqual(self.execute(), 0)
        self.assertEqual(self.execute(), 0)
        self.assertEqual(len(self.m.messages), 1)
        self.assertEqual(len(list(self.m.state_root.glob("launch-*.json"))), 2)

    def test_two_cycles_and_review_route_via_deployment_loop(self):
        self.assertEqual(self.execute(), 0)
        self.s.execute()
        self.s.new_turn(("met", "actionable"))
        self.assertEqual(self.execute(), 0)
        self.s.execute()
        self.s.new_turn(("met", "met"))
        self.assertEqual(self.execute(), 0)
        status = read_json(self.m.state_root / "status.json")
        self.assertEqual(status["scheduler"]["route"], "acceptance_review")
        self.assertEqual(len(self.m.messages), 2)

    def test_starting_receipt_is_not_active(self):
        def during_first_tick(_):
            with self.assertRaisesRegex(ValueError, "not_active"):
                deploy.verify(self.ref, call=self.m.fake)
            raise ValueError("test_failure")
        self.assertEqual(self.execute(tick=during_first_tick), 2)

    def test_exit_receipt_written_before_releasing_original_lock(self):
        replace = deploy.replace_json
        saw_exit = []
        def write(target, value):
            if target.name == "deployment-status.json" and value["phase"] == "exited":
                with self.assertRaises(BlockingIOError):
                    with bound_lock(self.config.root, self.config.ref, "monitor"):
                        pass
                saw_exit.append(True)
            replace(target, value)
        with patch.object(deploy, "replace_json", side_effect=write):
            self.assertEqual(self.execute(), 0)
        self.assertEqual(saw_exit, [True])

    def test_stop_not_cleared(self):
        publish_new(self.m.state_root / "monitor-stop.json", {"reason": "old_failure"})
        before = file_ref(self.m.state_root / "monitor-stop.json")
        with self.assertRaisesRegex(ValueError, "persistent_stop"):
            self.execute()
        self.assertEqual(before, file_ref(self.m.state_root / "monitor-stop.json"))
        self.assertFalse((self.m.state_root / "deployment-status.json").exists())
        self.assertEqual({p.name for p in self.m.state_root.iterdir()}, {"monitor-stop.json"})
        self.assertEqual(self.m.messages, [])

    def test_second_process_cannot_overwrite_receipt(self):
        with bound_lock(self.config.root, self.config.ref, "monitor"):
            with self.assertRaises(BlockingIOError):
                self.execute()
        self.assertFalse((self.m.state_root / "deployment-status.json").exists())

    def test_native_failure_does_not_activate(self):
        def fail(_):
            raise ValueError("monitor_coordinator_changed")
        self.assertEqual(self.execute(tick=fail), 2)
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json")["reason"], "monitor_coordinator_changed")
        self.assertIsNone(read_json(self.m.state_root / "deployment-status.json")["first_tick_at"])

    def test_verify_rejects_pid_heartbeat_and_sender_changes(self):
        def cases():
            with patch.object(deploy, "process_identity", return_value={**self.identity, "start_ticks": "999"}):
                with self.assertRaisesRegex(ValueError, "process_changed"):
                    deploy.verify(self.ref, call=self.m.fake)
            with patch.object(deploy, "process_environment", return_value={}):
                with self.assertRaisesRegex(ValueError, "own_operator_terminal"):
                    deploy.verify(self.ref, call=self.m.fake)
            self.m.operator_terminal["incarnationId"] = "replacement"
            with self.assertRaisesRegex(ValueError, "operator_terminal_unverifiable"):
                deploy.verify(self.ref, call=self.m.fake)
            receipt = read_json(self.m.state_root / "deployment-status.json")
            receipt["observed_at"] = (timestamp(now()) - timedelta(seconds=180)).isoformat()
            replace_json(self.m.state_root / "deployment-status.json", receipt)
            with self.assertRaisesRegex(ValueError, "heartbeat_stale"):
                deploy.verify(self.ref, call=self.m.fake)
        self.assertEqual(self.execute(observer=cases), 0)

    def test_dry_check_and_execute_guard(self):
        self.m.calls.clear()
        argv = ["--plan", self.ref["path"], "--plan-sha256", self.ref["sha256"]]
        with redirect_stdout(io.StringIO()):
            self.assertEqual(deploy.main(["check", *argv]), 0)
        with self.assertRaisesRegex(ValueError, "execution_not_enabled"):
            deploy.main(["run", *argv])
        self.assertEqual(list(self.m.state_root.iterdir()), [])
        self.assertEqual(self.m.calls, [])

    def test_real_host_process_identity(self):
        value = deploy.process_identity(os.getpid())
        self.assertEqual(value, deploy.process_identity(os.getpid()))
        self.assertTrue(value["start_ticks"].isdigit())
        self.assertEqual(len(value["argv_sha256"]), 64)


class NativeDeploymentTests(DeploymentTests):
    """Native mode must never enter either host /proc collector."""
    mode = "native-runtime"

    def execute(self, **kwargs):
        with patch.object(deploy, "own_sender_environment", return_value=self.m.environment), \
                patch.object(monitor, "native", side_effect=lambda args, runtime, timeout: self.m.fake(args, runtime)):
            return super().execute(**kwargs)

    def test_active_requires_first_tick_and_exit_is_not_active(self):
        proofs = []
        self.assertEqual(self.execute(observer=lambda: proofs.append(deploy.verify(self.ref, call=self.m.fake))), 0)
        self.assertEqual(proofs[0]["state"], "monitor_runtime_observed")
        self.assertFalse(proofs[0]["process_attested"])
        self.assertEqual(proofs[0]["evidence_mode"], "runtime-state-not-process-attested")
        self.assertNotIn("process", proofs[0])
        with self.assertRaisesRegex(ValueError, "not_active"):
            deploy.verify(self.ref, call=self.m.fake)

    def test_verify_rejects_pid_heartbeat_and_sender_changes(self):
        def cases():
            receipt = read_json(self.m.state_root / "deployment-status.json")
            replace_json(self.m.state_root / "deployment-status.json", {**receipt, "sender_environment": {}})
            with self.assertRaisesRegex(ValueError, "own_operator_terminal"):
                deploy.verify(self.ref, call=self.m.fake)
            replace_json(self.m.state_root / "deployment-status.json", receipt)
            self.m.operator_terminal["incarnationId"] = "replacement"
            with self.assertRaisesRegex(ValueError, "operator_terminal_unverifiable"):
                deploy.verify(self.ref, call=self.m.fake)
            receipt["observed_at"] = (timestamp(now()) - timedelta(seconds=180)).isoformat()
            replace_json(self.m.state_root / "deployment-status.json", receipt)
            with self.assertRaisesRegex(ValueError, "heartbeat_stale"):
                deploy.verify(self.ref, call=self.m.fake)
        self.assertEqual(self.execute(observer=cases), 0)

    def test_real_host_process_identity(self):
        # Test the production native path with host collectors forbidden, not Linux /proc.
        proofs = []
        original = monitor.tick
        with patch.object(deploy, "process_identity", side_effect=AssertionError("host collector called")), \
                patch.object(deploy, "process_environment", side_effect=AssertionError("host environment called")), \
                patch.object(deploy, "own_sender_environment", return_value=self.m.environment), \
                patch.object(monitor, "native", side_effect=lambda a, r, t: self.m.fake(a, r)), \
                patch.object(monitor, "tick", side_effect=lambda c: original(c, call=self.m.fake)), \
                patch("coordinator_tui_scheduler.schedule", side_effect=lambda *_: self.s.tick()), \
                redirect_stdout(io.StringIO()):
            replace = deploy.replace_json
            def write(target, data):
                replace(target, data)
                if target.name == "deployment-status.json" and data["phase"] == "monitoring":
                    proofs.append(deploy.verify(self.ref, call=self.m.fake))
            with patch.object(deploy, "replace_json", side_effect=write):
                self.assertEqual(deploy.run(self.ref, once=True), 0)
        self.assertEqual(len(proofs), 1)

    def test_stale_monitoring_receipt_requires_lock(self):
        receipts = []
        self.assertEqual(self.execute(observer=lambda: receipts.append(
            read_json(self.m.state_root / "deployment-status.json"))), 0)
        replace_json(self.m.state_root / "deployment-status.json", receipts[0])
        with self.assertRaisesRegex(ValueError, "lock_not_held"):
            deploy.verify(self.ref, call=self.m.fake)

    def test_restart_during_verify_is_not_active(self):
        def observe():
            def race(args, runtime, timeout):
                receipt = read_json(self.m.state_root / "deployment-status.json")
                receipt["phase"] = "exited"
                replace_json(self.m.state_root / "deployment-status.json", receipt)
                return self.m.fake(args, runtime)
            with self.assertRaisesRegex(ValueError, "tick_in_progress"):
                deploy.verify(self.ref, call=race)
        self.assertEqual(self.execute(observer=observe), 0)


if __name__ == "__main__":
    unittest.main()
