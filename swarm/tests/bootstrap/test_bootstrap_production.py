"""Production owner/transport/pull/S5, with explicitly fake native identity.

No Agent starts. Real sockets, peer credentials, files, locks and original
builder/prepare/delivery code run; these tests do not certify provider identity.
"""

from contextlib import contextmanager, redirect_stdout
import copy
from dataclasses import replace
from datetime import timedelta
import multiprocessing
import io
import os
import subprocess
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from bootstrap_control import AuthorityClient, CommitOwner, OwnerServer, ReadOnlyPollExpired, receive
from bootstrap_transport import verify
from bootstrap_identity import (process, unchanged, descendant, IdentitySnapshotExpired,
                                IdentityVerificationPending, IDENTITY_LEASE_SECONDS)
from bootstrap_protocol import EVENTS
from bootstrap_tool import RoleTool, cli_main
from coordinator_io import canonical, digest, file_ref, now, parse, pinned, publish_new, read_json, timestamp
import bootstrap.test_bootstrap_flow as flow_tests
from publication_wait_fixture import polling_watch


class TestIdentity:
    """Test-only peer mapping; never accepted by the production CLI."""
    def __init__(self, binding):
        self.registration = binding
        self.actor, self.valid = "coordinator", True
        self.mailbox = {"count": 0, "messages": []}

    def check(self):
        if not self.valid:
            raise ValueError("test_identity_stale")

    refresh = check

    def check_runtime(self):
        self.check()

    def refresh_runtime(self):
        self.refresh()

    def verify_run(self, contract):
        self.check_runtime()

    def authenticate(self, peer):
        unchanged(peer)
        return self.actor


class LeasedTestIdentity(TestIdentity):
    """Deterministically expire a lease without sleeping or changing wall time."""
    def __init__(self, binding):
        super().__init__(binding)
        self.expires, self.refreshes, self.failure = 0, 0, None

    def check(self):
        super().check()
        if time.monotonic() >= self.expires:
            raise IdentitySnapshotExpired("bootstrap_identity_snapshot_expired")

    def refresh(self):
        self.expires = 0
        self.refreshes += 1
        super().check()
        if self.failure:
            raise self.failure
        self.expires = time.monotonic() + IDENTITY_LEASE_SECONDS


@contextmanager
def production(*, armed=True, probe_names=None):
    f = flow_tests.BootstrapFlowTests()
    server = owner = None
    done, thread = threading.Event(), None
    endpoint_dir = tempfile.TemporaryDirectory(prefix="bootstrap-sock-", dir="/tmp")
    try:
        f.setUp()
        f.driver.close()
        f.authority.close()
        if probe_names is not None:
            f.b["file_tool_evidence_paths"] = [str(f.root / "coordinator" / name) for name in probe_names]
            Path(f.control.attempt_binding["path"]).write_bytes(canonical(f.b) + b"\n")
            f.control = replace(f.control, attempt_binding=file_ref(f.control.attempt_binding["path"]))
        registration = f.base.tui.ref("tool-registration.json", dict(schema_version=2,
            profile=str(f.base.tui.profile), log_root=str(f.base.tui.f.root),
            roles={"coordinator": {"provider": "trae", "session": "test-session"}}))
        identity = TestIdentity(registration)
        owner = CommitOwner(f.control, identity)
        for role in ("operator", "coordinator"):
            publish_new(f.root / "control" / (role + "-tool.lock"), b"")
        server = OwnerServer(owner, str(Path(endpoint_dir.name) / "owner.sock"))
        if armed:
            owner.arm(f.control)
        owner_ref = file_ref(f.root / "control" / "owner.json")
        thread = threading.Thread(target=server.serve, args=(done,))
        thread.start()
        client = AuthorityClient(f.control, owner_ref)
        with patch("bootstrap_tool.now", side_effect=lambda: f.base.clock.isoformat()), \
                patch("coordinator_request_prepare.now", side_effect=lambda: f.base.clock.isoformat()):
            yield f, owner, identity, client, owner_ref
    finally:
        done.set()
        if thread:
            thread.join(12)
            assert not thread.is_alive(), "test owner did not drain"
        if server:
            server.close()
        elif owner:
            owner.close()
        endpoint_dir.cleanup()
        f.doCleanups()


def read_child(control, owner_ref, ref, pipe):
    pipe.send(AuthorityClient(control, owner_ref).query(control, ref).status)
    pipe.close()


class TransportDeadlineTests(unittest.TestCase):
    def test_fragmented_reply_cannot_restart_budget(self):
        connection = Mock()
        connection.recv.side_effect = [b'{', b'"', b'x']
        with patch("bootstrap_control.time") as clock:
            clock.monotonic.side_effect = [0, 12, 24, 30]
            with self.assertRaisesRegex(TimeoutError, "bootstrap_rpc_transport_timeout"):
                receive(connection, deadline=30)
        self.assertEqual(connection.recv.call_count, 3)
        self.assertEqual([c.args[0] for c in connection.settimeout.call_args_list], [30, 18, 6])

    def test_fragmented_valid_reply_within_deadline(self):
        connection = Mock()
        connection.recv.side_effect = [b'{"ok":', b'true}', b'']
        with patch("bootstrap_control.time") as clock:
            clock.monotonic.side_effect = [0, 1, 2]
            self.assertEqual(receive(connection, deadline=30), {"ok": True})

    def test_rpc_caps_budget_restores_scope_and_never_retries(self):
        client = object.__new__(AuthorityClient)
        client.deadline, client.read_only_poll = None, False
        def timeout(*args, **kwargs):
            self.assertEqual(client.deadline, 130)
            raise TimeoutError("private detail")
        with patch("bootstrap_control.time") as clock, patch.object(client, "_rpc", side_effect=timeout) as rpc:
            clock.monotonic.return_value = 100
            with self.assertRaisesRegex(ValueError, "^bootstrap_tool_timeout_requires_reconciliation$"):
                client.rpc("runtime-attest-trigger")
            rpc.assert_called_once()
        self.assertIsNone(client.deadline)
        with client.polling(110), patch("bootstrap_control.time") as clock:
            clock.monotonic.return_value = 100
            def poll_timeout(*args, **kwargs):
                self.assertEqual(client.deadline, 110)
                raise TimeoutError()
            with patch.object(client, "_rpc", side_effect=poll_timeout) as rpc:
                with self.assertRaises(ReadOnlyPollExpired):
                    client.rpc("observe")
                rpc.assert_called_once()
            self.assertEqual(client.deadline, 110)
        self.assertIsNone(client.deadline)
        self.assertFalse(client.read_only_poll)


class ProductionTests(unittest.TestCase):
    def test_non_role_observer_gets_health_not_review_or_commit_authority(self):
        with production() as (f, owner, identity, client, _):
            with patch.object(identity, "authenticate", side_effect=ValueError("not_an_original_role")):
                self.assertEqual(client.observe(f.control), {"state": "ready"})
                with self.assertRaisesRegex(ValueError, "rpc_rejected"):
                    client.active(f.control)
                owner.invalidate()
                with self.assertRaisesRegex(ValueError, "rpc_rejected"):
                    client.observe(f.control)

    def emit(self, f, client, name="caller_receipt", raw=b"test"):
        return client.commit_new(f.control, actor="coordinator", target=f.paths[name], raw=raw,
                                prerequisites=[], recheck=lambda: None).target

    def lease(self, owner, f):
        identity = LeasedTestIdentity(f.control.attempt_binding)
        owner.identity = identity
        identity.refresh()
        return identity

    def test_cached_heartbeats_do_not_slide_lease_and_expiry_renews(self):
        with production() as (f, owner, _, client, _):
            identity = self.lease(owner, f)
            deadline, expires = f.b["deadline"], identity.expires
            for _ in range(3):
                self.assertEqual(client.heartbeat(f.control, "coordinator")["state"], "ready")
            self.assertEqual(identity.expires, expires)
            self.assertEqual(identity.refreshes, 1)
            self.assertEqual(client.last_heartbeat["evidence"], "signed_request_bound_reply")
            identity.expires = 0
            self.assertEqual(client.heartbeat(f.control, "coordinator")["state"], "ready")
            self.assertEqual(identity.refreshes, 2)
            self.assertGreater(identity.expires, time.monotonic() + 29)
            self.assertEqual(f.b["deadline"], deadline)
            self.assertTrue(owner.armed)

    def test_near_expiry_heartbeat_refreshes_early(self):
        with production() as (f, owner, _, client, _):
            identity = self.lease(owner, f)
            identity.expires = time.monotonic() + 4
            client.heartbeat(f.control, "coordinator")
            self.assertEqual(identity.refreshes, 2)

    def test_slow_cached_local_check_reverifies_once(self):
        with production() as (f, owner, _, client, _):
            identity = self.lease(owner, f)
            original = identity.check
            calls = []
            def slow_check():
                if not calls:
                    identity.expires = 0
                calls.append(True)
                original()
            with patch.object(identity, "check", side_effect=slow_check):
                client.heartbeat(f.control, "coordinator")
            self.assertEqual(identity.refreshes, 2)
            self.assertTrue(owner.armed)

    def test_expiry_between_refresh_and_heartbeat_is_reverified(self):
        with production() as (f, owner, _, client, _):
            identity = self.lease(owner, f)
            original = owner.heartbeat
            calls = []
            def slow_heartbeat(control):
                if not calls:
                    identity.expires = 0
                calls.append(True)
                return original(control)
            with patch.object(owner, "heartbeat", side_effect=slow_heartbeat):
                self.assertEqual(client.heartbeat(f.control, "coordinator")["state"], "ready")
            self.assertEqual(len(calls), 2)
            self.assertEqual(identity.refreshes, 2)

    def test_native_timeout_pending_preserves_history_then_recovers_without_arm(self):
        with production() as (f, owner, _, client, _):
            identity = self.lease(owner, f)
            client.heartbeat(f.control, "coordinator")
            heartbeat = client.last_heartbeat
            identity.expires = 0
            identity.failure = IdentityVerificationPending("bootstrap_native_identity_timeout")
            tool = RoleTool(f.control, client, "coordinator")
            try:
                result = tool.pull(30)
                self.assertEqual(result["reason"], "identity_reverification_pending")
                self.assertEqual(result["current_liveness"], "unverified")
                self.assertEqual(result["last_verified_heartbeat"], heartbeat)
                self.assertEqual(result["deadline"], f.b["deadline"])
                self.assertTrue(owner.armed)
                self.assertFalse(owner.attempted)
                with self.assertRaisesRegex(ValueError, "native_identity_timeout"):
                    self.emit(f, client)
                self.assertFalse(owner.attempted)
                identity.failure = None
                self.assertEqual(client.heartbeat(f.control, "coordinator")["state"], "ready")
                self.emit(f, client)
            finally:
                tool.close()

    def test_untyped_timeout_denial_is_not_pending(self):
        with production() as (f, owner, _, client, _):
            identity = self.lease(owner, f)
            identity.expires = 0
            identity.failure = ValueError("bootstrap_native_identity_timeout")
            with client.polling(time.monotonic() + 30):
                with self.assertRaises(ValueError) as caught:
                    client.heartbeat(f.control, "coordinator")
            self.assertNotIsInstance(caught.exception, IdentityVerificationPending)
            self.assertFalse(owner.armed)

    def test_repeated_heartbeat_expiry_returns_pending_with_one_retry(self):
        with production() as (f, owner, _, client, _):
            identity = self.lease(owner, f)
            tool = RoleTool(f.control, client, "coordinator")
            original = owner.heartbeat
            def expired(control):
                identity.expires = 0
                return original(control)
            try:
                with patch.object(owner, "heartbeat", side_effect=expired) as check:
                    result = tool.pull(30)
                self.assertEqual(result["reason"], "identity_reverification_pending")
                self.assertEqual(check.call_count, 2)
                self.assertEqual(identity.refreshes, 2)
                self.assertIsNone(client.last_heartbeat)
                self.assertTrue(owner.armed)
                self.assertFalse(owner.attempted)
            finally:
                tool.close()

    def test_initializing_timeout_recovers_to_awaiting_arm_not_ready(self):
        with production(armed=False) as (f, owner, _, client, _):
            identity = self.lease(owner, f)
            identity.expires = 0
            identity.failure = IdentityVerificationPending("bootstrap_native_identity_timeout")
            with client.polling(time.monotonic() + 30):
                with self.assertRaises(IdentityVerificationPending):
                    client.heartbeat(f.control, "coordinator")
            self.assertTrue(owner.initializing)
            self.assertFalse(owner.armed)
            identity.failure = None
            self.assertEqual(client.heartbeat(f.control, "coordinator")["state"], "awaiting_arm")

    def test_preadmission_expiry_rechecks_outside_lock_and_publishes_once(self):
        with production() as (f, owner, _, client, _):
            identity = self.lease(owner, f)
            calls = []
            def recheck():
                if not calls:
                    identity.expires = 0
                calls.append(True)
            original = identity.refresh
            def refresh():
                self.assertFalse(owner.serial._is_owned())
                original()
            with patch.object(identity, "refresh", side_effect=refresh), \
                    patch("bootstrap_control.io.publish_new", wraps=publish_new) as publish:
                ref = owner.commit_new(f.control, actor="coordinator", target=f.paths["caller_receipt"],
                    raw=b"test", prerequisites=[], recheck=recheck).target
            self.assertEqual(len(calls), 2)
            self.assertEqual(publish.call_count, 1)
            self.assertEqual(client.query(f.control, ref).status, "confirmed")

    def test_repeated_preadmission_expiry_is_bounded_without_publication(self):
        with production() as (f, owner, _, client, _):
            identity = self.lease(owner, f)
            with patch("bootstrap_control.io.publish_new", wraps=publish_new) as publish:
                with self.assertRaises(IdentitySnapshotExpired):
                    owner.commit_new(f.control, actor="coordinator", target=f.paths["caller_receipt"],
                        raw=b"test", prerequisites=[], recheck=lambda: setattr(identity, "expires", 0))
            self.assertEqual(identity.refreshes, 2)
            self.assertFalse(publish.called)
            self.assertFalse(owner.attempted)
            self.assertTrue(owner.armed)

    def test_publication_exception_never_enters_expiry_retry(self):
        with production() as (f, owner, _, client, _):
            identity = self.lease(owner, f)
            with patch("bootstrap_control.io.publish_new", side_effect=IdentitySnapshotExpired(
                    "bootstrap_identity_snapshot_expired")) as publish:
                with self.assertRaises(IdentitySnapshotExpired):
                    owner.commit_new(f.control, actor="coordinator", target=f.paths["caller_receipt"],
                        raw=b"test", prerequisites=[], recheck=lambda: None)
            self.assertEqual(publish.call_count, 1)
            self.assertEqual(identity.refreshes, 1)
            self.assertIn(f.paths["caller_receipt"], owner.attempted)
            self.assertFalse(owner.armed)

    def test_revalidation_cannot_reopen_failed_owner_or_clear_stop(self):
        with production() as (f, owner, _, client, _):
            identity = self.lease(owner, f)
            identity.valid, identity.expires = False, 0
            with self.assertRaises(ValueError):
                client.heartbeat(f.control, "coordinator")
            identity.valid = True
            with self.assertRaisesRegex(ValueError, "owner_closed"):
                client.heartbeat(f.control, "coordinator")
            self.assertFalse(owner.armed)
            client.stop(f.control)
            refreshes = identity.refreshes
            identity.expires = 0
            with self.assertRaisesRegex(ValueError, "stopped"):
                client.heartbeat(f.control, "coordinator")
            self.assertEqual(identity.refreshes, refreshes)

    def test_real_transport_and_separate_process_readonly_consumer(self):
        with production() as (f, owner, identity, client, owner_ref):
            ref = self.emit(f, client)
            before = {str(p): (p.read_bytes(), p.stat().st_mtime_ns) for p in f.root.rglob("*") if p.is_file()}
            a, b = multiprocessing.Pipe()
            child = multiprocessing.Process(target=read_child, args=(f.control, owner_ref, ref, b))
            child.start()
            self.assertTrue(a.poll(5))
            self.assertEqual(a.recv(), "confirmed")
            child.join(5)
            self.assertEqual(child.exitcode, 0)
            a.close()
            b.close()
            after = {str(p): (p.read_bytes(), p.stat().st_mtime_ns) for p in f.root.rglob("*") if p.is_file()}
            self.assertEqual(before, after)

    def test_wrong_role_and_path_rejected(self):
        with production() as (f, owner, identity, client, _):
            identity.actor = "operator"
            with self.assertRaisesRegex(ValueError, "rpc_rejected"):
                self.emit(f, client)
            self.assertFalse(Path(f.paths["caller_receipt"]).exists())
            with self.assertRaisesRegex(ValueError, "rpc_rejected"):
                client.commit_new(f.control, actor="operator", target=str(f.root / "outside.json"),
                                  raw=b"x", prerequisites=[], recheck=lambda: None)

    def test_stop_closes_new_commits_retains_confirmed_facts(self):
        with production() as (f, owner, identity, client, _):
            ref = self.emit(f, client)
            client.stop(f.control)
            self.assertEqual(client.query(f.control, ref).status, "confirmed")
            with self.assertRaisesRegex(ValueError, "rpc_rejected"):
                self.emit(f, client, "final_readiness")
            self.assertFalse(Path(f.paths["final_readiness"]).exists())

    def test_stale_identity_closes_admission_but_not_durability_query(self):
        with production() as (f, owner, identity, client, _):
            ref = self.emit(f, client)
            identity.valid = False
            with self.assertRaisesRegex(ValueError, "rpc_rejected"):
                self.emit(f, client, "final_readiness")
            self.assertEqual(client.query(f.control, ref).status, "confirmed")
            identity.valid = True
            with self.assertRaisesRegex(ValueError, "rpc_rejected"):
                self.emit(f, client, "final_readiness")
            self.assertFalse(owner.armed)
            identity.actor = "operator"
            client.rpc("arm")
            identity.actor = "coordinator"
            self.emit(f, client, "final_readiness")

    def test_fsync_gap_exact_same_owner_reconciliation_without_rewrite(self):
        with production() as (f, owner, identity, client, _):
            with patch("coordinator_io.fsync_dir", side_effect=OSError("test barrier")):
                # A failed publish is an unknown outcome, never a retryable reply.
                with self.assertRaises(ValueError) as caught:
                    self.emit(f, client)
            self.assertEqual((caught.exception.commit_state, caught.exception.may_replay),
                             ("unknown", False))
            ref = file_ref(f.paths["caller_receipt"])
            before = Path(ref["path"]).stat().st_mtime_ns
            self.assertEqual(client.query(f.control, ref).status, "durability_unverified")
            self.assertEqual(client.query(f.control, ref).state, "needs_reconcile")
            identity.actor = "operator"
            self.assertEqual(client.rpc("reconcile", target=ref)["status"], "confirmed")
            self.assertFalse(owner.armed)
            client.rpc("arm")
            self.assertEqual(Path(ref["path"]).stat().st_mtime_ns, before)
            self.assertTrue(owner.armed)

    def test_dead_owner_or_generation_never_confirms_visible_file(self):
        with production() as (f, owner, identity, client, _):
            ref = self.emit(f, client)
            self.assertEqual(owner.query(replace(f.control, generation="other"), ref).status,
                             "durability_unverified")
            owner.close()
            self.assertEqual(client.query(f.control, ref).status, "durability_unverified")

    def test_duplicate_owner_generation_registration_cannot_be_reused(self):
        with production() as (f, owner, identity, client, _):
            with self.assertRaises(BlockingIOError):
                CommitOwner(f.control, identity)
            owner.close()
            next_owner = CommitOwner(f.control, identity)
            try:
                with tempfile.TemporaryDirectory(prefix="bootstrap-next-", dir="/tmp") as directory:
                    with self.assertRaises(FileExistsError):
                        OwnerServer(next_owner, str(Path(directory) / "socket"))
            finally:
                next_owner.close()

    def test_process_start_and_ancestry_are_not_uid_only(self):
        anchor = process(os.getpid())
        unchanged(anchor)
        descendant(os.getpid(), anchor)
        with self.assertRaisesRegex(ValueError, "process_changed"):
            unchanged(dict(anchor, start="different"))
        with self.assertRaisesRegex(ValueError, "wrong_process_tree"):
            descendant(1, anchor)

    def test_pull_pending_is_bounded_and_no_implicit_wakeup(self):
        with production() as (f, owner, identity, client, _):
            identity.actor = "operator"
            tool = RoleTool(f.control, client, "operator")
            try:
                # Include real signing/verification and NAS I/O in this budget.
                # Deadline rejection is covered deterministically below.
                self.assertEqual(tool.pull(2)["state"], "pending")
                with self.assertRaisesRegex(ValueError, "bounded_wait"):
                    tool.pull(61)
            finally:
                tool.close()

    def test_initial_wait_uses_signed_heartbeat_then_original_operator_arm(self):
        with production(armed=False) as (f, owner, identity, client, _):
            tool = RoleTool(f.control, client, "coordinator")
            try:
                self.assertEqual(client.heartbeat(f.control, "coordinator")["state"], "awaiting_arm")
                result = tool.pull(0.3)
                self.assertEqual(result["state"], "pending")
                self.assertEqual(result["last_verified_heartbeat"]["state"], "awaiting_arm")
                self.assertEqual(result["current_liveness"], "unverified")
                self.assertFalse(owner.armed)
                self.assertFalse(Path(f.paths["caller_receipt"]).exists())
                self.assertFalse(Path(tool.paths["caller-intent"]).exists())
                with self.assertRaisesRegex(ValueError, "recovery_operator_required"):
                    client.rpc("arm")
                identity.actor = "operator"
                client.rpc("arm")
                identity.actor = "coordinator"
                self.assertEqual(tool.pull(30)["action"], "caller-intent")
            finally:
                tool.close()

    def test_failed_initial_arm_never_reverts_to_awaiting_arm(self):
        with production(armed=False) as (f, owner, identity, client, _):
            identity.actor, identity.valid = "operator", False
            with self.assertRaises(ValueError):
                client.rpc("arm")
            identity.valid = True
            with self.assertRaisesRegex(ValueError, "owner_closed"):
                client.heartbeat(f.control, "operator")
            self.assertFalse(owner.initializing)

    def test_heartbeat_cli_and_plan_do_not_arm_or_publish(self):
        from bootstrap_s5 import role_plan
        with production(armed=False) as (f, owner, identity, client, owner_ref):
            args = ["heartbeat", "--owner", owner_ref["path"], "--owner-sha256", owner_ref["sha256"]]
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(cli_main([*args, "--actor", "coordinator"]), 0)
            result = parse(output.getvalue().encode())["result"]
            self.assertEqual(result["state"], "awaiting_arm")
            self.assertEqual(result["owner"], owner_ref)
            self.assertEqual(result["evidence"], "signed_request_bound_reply")
            self.assertFalse(result["execution_authorized"])
            for extra in ([], ["--actor", "coordinator", "--execute"]):
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(cli_main([*args, *extra]), 2)
            plan = role_plan(owner_ref)
            self.assertIn("explicitly arm", plan["stages"][0])
            self.assertIn("never arm", plan["stages"][1])
            self.assertTrue(any("do not prove death" in rule for rule in plan["rules"]))
            self.assertTrue(any("candidate_path" in stage for stage in plan["stages"]))
            self.assertTrue(any("complete_argv" in rule for rule in plan["rules"]))
            self.assertTrue(any("owner-only output" in rule for rule in plan["rules"]))
            self.assertNotIn("produce fixed fields", " ".join(plan["stages"]))
            self.assertFalse(owner.armed)
            self.assertEqual(owner.attempted, {})

    def test_recovery_stop_and_dead_owner_are_not_initial_waiting(self):
        with production() as (f, owner, identity, client, _):
            owner.invalidate()
            with self.assertRaisesRegex(ValueError, "owner_closed"):
                client.heartbeat(f.control, "coordinator")
            client.stop(f.control)
            with self.assertRaisesRegex(ValueError, "bootstrap_stopped"):
                client.heartbeat(f.control, "coordinator")
            owner.close()
            with self.assertRaisesRegex(ValueError, "owner_or_generation_changed"):
                client.heartbeat(f.control, "coordinator")

    def test_readonly_scope_blocks_mutations_and_restores_deadline(self):
        with production() as (f, owner, identity, client, _):
            prior = time.monotonic() + 10
            client.deadline = prior
            with client.polling(time.monotonic() + 20):
                self.assertEqual(client.deadline, prior)
                for op in ("arm", "stop", "commit", "settle", "reconcile"):
                    with self.assertRaisesRegex(ValueError, "poll_mutation_forbidden"):
                        client.rpc(op)
            self.assertFalse(client.read_only_poll)
            self.assertEqual(client.deadline, prior)
            self.assertTrue(owner.armed)
            self.assertFalse(owner.stopped)

    def test_late_signed_heartbeat_is_pending_not_fresh_liveness(self):
        with production() as (f, owner, identity, client, _):
            identity.actor = "operator"
            tool = RoleTool(f.control, client, "operator")
            def expire(*args, **kwargs):
                reply = verify(*args, **kwargs)
                client.deadline = time.monotonic() - 1
                return reply
            try:
                with patch("bootstrap_control.verify", side_effect=expire):
                    result = tool.pull(2)
                self.assertEqual(result["reason"], "read_only_poll_expired")
                self.assertIsNone(result["last_verified_heartbeat"])
                self.assertIsNone(client.deadline)
                self.assertFalse(client.read_only_poll)
            finally:
                tool.close()

    def test_pull_respects_prior_deadline_and_closed_tool(self):
        with production(armed=False) as (f, owner, identity, client, _):
            tool = RoleTool(f.control, client, "coordinator")
            prior = time.monotonic() - 1
            client.deadline = prior
            try:
                with patch.object(client, "rpc", side_effect=AssertionError("expired pull sent RPC")):
                    self.assertEqual(tool.pull(30)["state"], "pending")
                self.assertEqual(client.deadline, prior)
                self.assertFalse(client.read_only_poll)
                tool.close()
                with self.assertRaisesRegex(ValueError, "driver_stopped"):
                    tool.pull(30)
            finally:
                tool.close()

    def test_real_socket_slow_heartbeat_returns_pending_then_recovers(self):
        with production() as (f, owner, identity, client, _):
            identity.actor = "operator"
            tool = RoleTool(f.control, client, "operator")
            entered, release = threading.Event(), threading.Event()
            previous_refresh = identity.refresh
            def delayed_refresh():
                entered.set()
                if not release.wait(5):
                    raise ValueError("test_release_missing")
                previous_refresh()
            try:
                client.heartbeat(f.control, "operator")
                previous_heartbeat = client.last_heartbeat
                with patch.object(identity, "refresh", side_effect=delayed_refresh):
                    try:
                        result = tool.pull(1)
                    finally:
                        release.set()
                self.assertTrue(entered.is_set())
                self.assertEqual(result["reason"], "read_only_poll_expired")
                self.assertEqual(result["last_verified_heartbeat"], previous_heartbeat)
                self.assertEqual(result["current_liveness"], "unverified")
                self.assertEqual(owner.attempted, {})
                self.assertTrue(owner.armed)
                # Releasing the fixture's I/O does not prove the original RPC
                # drained. The bounded ingress now rejects concurrent protocol
                # work instead of silently queueing a second heartbeat.
                from bootstrap_diagnostics import diagnose
                deadline = time.monotonic() + 3
                while diagnose(client.owner["endpoint"])["state"] == "busy":
                    self.assertLess(time.monotonic(), deadline, "original heartbeat did not drain")
                    time.sleep(.01)
                # Diagnostic idle is not liveness: verify a fresh signed reply.
                self.assertEqual(client.heartbeat(f.control, "operator")["state"], "ready")
            finally:
                release.set()
                tool.close()

    def test_late_authenticated_stop_denial_is_not_pending(self):
        with production() as (f, owner, identity, client, _):
            tool = RoleTool(f.control, client, "coordinator")
            client.stop(f.control)
            def expire(*args, **kwargs):
                reply = verify(*args, **kwargs)
                client.deadline = time.monotonic() - 1
                return reply
            try:
                with patch("bootstrap_control.verify", side_effect=expire):
                    with self.assertRaisesRegex(ValueError, "bootstrap_stopped"):
                        tool.pull(30)
                self.assertIsNone(client.last_heartbeat)
            finally:
                tool.close()

    def test_slow_idle_check_returns_pending_without_mutation(self):
        with production() as (f, owner, identity, client, _):
            identity.actor = "operator"
            tool = RoleTool(f.control, client, "operator")
            original_rpc = client._rpc
            calls = []
            def slow_check(op, **args):
                calls.append(op)
                if op == "check":
                    # The prior heartbeat is valid; the next read-only check
                    # reaches its deadline without any mutation being admitted.
                    client.deadline = time.monotonic() - 1
                return original_rpc(op, **args)
            try:
                with patch.object(client, "_rpc", side_effect=slow_check):
                    result = tool.pull(30)
                self.assertEqual(calls, ["heartbeat", "check"])
                self.assertEqual(result["reason"], "read_only_poll_expired")
                self.assertEqual(result["last_verified_heartbeat"]["state"], "ready")
                self.assertEqual(result["current_liveness"], "unverified")
                self.assertEqual(owner.attempted, {})
            finally:
                tool.close()

    def test_readonly_query_deadline_propagates_not_false_durability(self):
        with production() as (f, owner, identity, client, _):
            ref = self.emit(f, client)
            with client.polling(time.monotonic() - 1):
                with self.assertRaises(ReadOnlyPollExpired):
                    client.query(f.control, ref)
            self.assertEqual(client.query(f.control, ref).status, "confirmed")

    def test_mutation_reply_lost_still_requires_reconciliation(self):
        with production() as (f, owner, identity, client, _):
            tool = RoleTool(f.control, client, "coordinator")
            original_rpc = client._rpc
            commits = []
            def lose_reply(op, **args):
                reply = original_rpc(op, **args)
                if op == "commit":
                    commits.append(args["target"])
                    raise TimeoutError("lost commit reply")
                return reply
            try:
                with patch.object(client, "_rpc", side_effect=lose_reply):
                    with self.assertRaisesRegex(ValueError, "bootstrap_tool_timeout_requires_reconciliation") as caught:
                        tool.pull(30)
                self.assertIsInstance(caught.exception.__cause__, TimeoutError)
                self.assertEqual(len(commits), 1)
                self.assertFalse(client.read_only_poll)
                self.assertIsNone(client.deadline)
                result = tool.pull(30)
                self.assertEqual(result["state"], "reconciliation_required")
                self.assertEqual(result["action"], "caller-intent")
            finally:
                tool.close()

    def test_heartbeat_signature_and_role_errors_never_become_pending(self):
        with production() as (f, owner, identity, client, _):
            identity.actor = "operator"
            tool = RoleTool(f.control, client, "coordinator")
            try:
                with self.assertRaisesRegex(ValueError, "heartbeat_invalid"):
                    tool.pull(30)
                identity.actor = "coordinator"
                with patch("bootstrap_control.verify", side_effect=ValueError("bootstrap_signature_invalid")):
                    with self.assertRaisesRegex(ValueError, "signature_invalid"):
                        tool.pull(30)
                self.assertIsNone(client.last_heartbeat)
            finally:
                tool.close()

    def test_signed_reply_after_deadline_requires_reconciliation(self):
        with production() as (f, owner, identity, client, _):
            ref = self.emit(f, client)

            def expire_after_verify(*args, **kwargs):
                reply = verify(*args, **kwargs)
                client.deadline = time.monotonic() - 1
                return reply

            with patch("bootstrap_control.verify", side_effect=expire_after_verify) as checked:
                with self.assertRaisesRegex(ValueError, "timeout_requires_reconciliation"):
                    client.rpc("query", target=ref)
                client.deadline = None
                self.assertEqual(client.query(f.control, ref).status, "durability_unverified")
                self.assertEqual(checked.call_count, 2)

    def flow(self, f, identity, client):
        from bootstrap_actions import ACTIONS
        from bootstrap_role_fixture import RoleWorkflow
        workflow = RoleWorkflow(f, identity, client.owner_ref)
        for name, spec in ACTIONS.items():
            action = workflow.pull(spec.actor)
            self.assertEqual(action["state"], "action")
            self.assertEqual(action["action"], name)
            repeated = workflow.pull(spec.actor)
            self.assertEqual(repeated, dict(action, state="reconciliation_required", complete_argv=None))
            before = workflow.returned_command(repeated, "inspect_argv")
            self.assertFalse(before["retry_allowed"])
            self.assertEqual(before["state"], "reconciliation_required")
            candidates = []
            if spec.mode != "produce":
                submission = action["submission"]
                self.assertEqual(submission, parse(pinned(action["intent"]))["payload"]["submission"])
                self.assertEqual(submission["final_path"], action["result_path"])
                self.assertEqual(submission["final_writer"], "commit_owner")
                if spec.mode == "submit":
                    request = parse(pinned(action["payload"]["request"]))
                    self.assertEqual(request["schema_version"], 1)
                    self.assertNotIn("submission", request)  # Frozen wire request is unchanged.
                workflow.write_candidates(action)
                candidates = [file_ref(output["candidate_path"]) for output in submission["outputs"]]
                for ref in candidates:
                    self.assertEqual(client.query(f.control, ref).status, "durability_unverified")
            workflow.complete(action, write=False)
            inspected = workflow.returned_command(action, "inspect_argv")
            self.assertEqual(inspected["state"], "confirmed")
            self.assertFalse(inspected["retry_allowed"])
            for ref, output in zip(candidates, action.get("submission", {}).get("outputs", [])):
                final_ref = dict(ref, path=output["final_path"])
                self.assertEqual(client.query(f.control, final_ref).status, "confirmed")
                self.assertEqual(pinned(final_ref), pinned(ref))
                self.assertFalse(os.path.samefile(ref["path"], final_ref["path"]))
            if name in {"caller-intent", "contract-intent", "readiness-intent"}:
                workflow.advance_marker(spec.actor)
        self.assertEqual(workflow.pull("coordinator")["state"], "request_ready")
        identity.actor = "coordinator"
        tool = RoleTool(f.control, client, "coordinator")
        try:
            return tool.build(f.base.source)
        finally:
            tool.close()

    def test_two_original_role_tool_returns_actual_builder_and_actual_s5_prepare_delivery(self):
        self.complete_s5()

    def test_stop_before_s5_gate_prevents_create_in_actual_entry(self):
        self.complete_s5(stop_before_create=True)

    def test_established_runtime_crosses_bootstrap_deadline_over_original_socket(self):
        self.complete_s5(runtime_checks=True)

    def complete_s5(self, *, stop_before_create=False, runtime_checks=False):
        from coordinator_request_prepare import prepare_request, review_request
        from coordinator_strict_delivery import deliver
        with production() as (f, owner, identity, client, owner_ref):
            request = self.flow(f, identity, client)
            self.assertEqual(parse(pinned(request))["schema_version"], 5)
            with self.assertRaisesRegex(ValueError, "bootstrap_owner_required"):
                prepare_request(request)
            identity.actor = "operator"
            with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
                prepared = prepare_request(request, bootstrap_owner=owner_ref)
                review = review_request(request, decision="approve", notes="Independent offline review",
                                        bootstrap_owner=owner_ref)
                from operator_startup import prepare as prepare_lifecycle
                output = f.root / "lifecycle"
                output.mkdir(mode=0o700)
                values = dict(schema_version=2, strict_start=prepared["config"], bootstrap_owner=owner_ref,
                    execution={"mode": "manual", "trigger": None}, workers="not-applicable",
                    runtime=dict(schema_version=1, deadline=f.base.source["task_deadline"], authority=f.b["authorization_refs"]),
                    continuation_publication=str(f.root / "continuation" / "continuation-ref.json"),
                    sender=dict(terminal="term_sender", incarnation="inc_sender", workspace="workspace_sender"),
                    poll_seconds=1, bootstrap_deadline=f.b["deadline"])
                for key in ("state_root", "monitor_state_root", "deployment_dir"):
                    folder = f.root / key
                    folder.mkdir(mode=0o700)
                    values[key] = str(folder)
                candidate = f.root / "operator" / "lifecycle-inputs.json"
                publish_new(candidate, values)
                lifecycle = prepare_lifecycle(file_ref(candidate), str(output))
                delivered = deliver(request, prepared["config"], prepared["preparation"], review["review"],
                                    bootstrap_owner=owner_ref)
                self.assertEqual(parse(pinned(delivered["publication"]))["lifecycle"], lifecycle)
            self.assertEqual(client.query(f.control, delivered["publication"]).status, "confirmed")
            self.assertEqual(prepared["plan"]["bootstrap_owner"], owner_ref)
            # Real strict-config waiter + strict-start publisher/create logic.
            # Native gate/check/query results remain deterministic mocks.
            from coordinator_strict_delivery import wait_for_config
            from coordinator_strict_start import wait_and_create, publish
            native_calls, runs = [], []
            directory = f.root / "strict-start"
            def native(cli, runtime, args):
                native_calls.append(args)
                if args[:2] == ["orchestration", "run-current"]:
                    return {"run": runs[-1] if runs else None}
                if args[:2] == ["orchestration", "run-show"]:
                    return {"run": runs[-1]}
                if args[:2] == ["orchestration", "run-create"]:
                    run = dict(id="run_test_created", objective=parse(pinned(request))["objective"],
                               coordinator_handle="term_test", consumer_generation=1,
                               created_at=f.base.clock.isoformat(timespec="seconds"))
                    runs.append(run)
                    return dict(run=run, coordinatorPolicy="strict-v1")
                self.fail(args)
            def sleep(seconds):
                f.base.clock += timedelta(seconds=seconds)
                if stop_before_create:
                    client.stop(f.control)
                    return
                if not (directory / "gate-ready.json").exists():
                    identity.actor = "operator"
                    from coordinator_startup import KIND, identity as contract_identity
                    contract_ref = parse(pinned(prepared["config"]))["contract"]
                    binding = contract_identity(parse(pinned(contract_ref)))
                    receipt = dict(ok=True, phase="session", actor="operator", schema_version=2, kind=KIND,
                                   binding=binding, identity_sha256=digest(canonical(binding)),
                                   contract_sha256=contract_ref["sha256"],
                                   started_at=f.base.clock.isoformat(), completed_at=f.base.clock.isoformat(),
                                   valid_until=(f.base.clock + timedelta(seconds=180)).isoformat())
                    with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}), \
                            patch("coordinator_strict_start.run_gate", return_value=receipt):
                        # Simulate a separate tool context, not reentrant S5.
                        from bootstrap_s5 import current
                        token = current.set(None)
                        try:
                            publish(received["config"], file_ref(directory / "ready.json"), bootstrap_owner=owner_ref)
                        finally:
                            current.reset(token)
                    identity.actor = "coordinator"
            identity.actor = "coordinator"
            with patch("coordinator_strict_delivery.live") as delivery_live, \
                    patch("coordinator_strict_start.live") as start_live, \
                    patch("coordinator_strict_start.check_session", return_value={"ok": True}), \
                    patch("coordinator_strict_start.native", side_effect=native), \
                    patch("coordinator_strict_start.now", side_effect=lambda: f.base.clock.isoformat()), \
                    patch("coordinator_strict_start.time", wraps=time) as start_time, \
                    patch("publication_wait.watch", polling_watch(sleep)):
                # Do not replace process-global time.sleep: subprocess uses it
                # while waiting for the real owner-signature verifier.
                start_time.sleep.side_effect = sleep
                received = wait_for_config(request, bootstrap_owner=owner_ref)
                if stop_before_create:
                    with self.assertRaisesRegex(ValueError, "rpc_rejected"):
                        wait_and_create(received["config"], bootstrap_owner=owner_ref)
                    self.assertFalse(runs)
                    self.assertFalse((directory / "create-intent.json").exists())
                    self.assertFalse((directory / "created.json").exists())
                    return
                result = wait_and_create(received["config"], bootstrap_owner=owner_ref)
            self.assertTrue(result["ok"])
            self.assertEqual(len(runs), 1)
            self.assertGreaterEqual(delivery_live.call_count, 2)
            self.assertGreaterEqual(start_live.call_count, 3)
            self.assertEqual(client.query(f.control, file_ref(directory / "created.json")).status, "confirmed")
            # S5's returned lifecycle reaches a real original-role task/accept/
            # complete over the same owner socket, not only a visible JSON file.
            import startup_handoff as handoff
            from operator_startup import load as load_lifecycle
            plan, start, session, _ = load_lifecycle(lifecycle)
            run_contract = dict(session, run=dict(id=runs[0]["id"], generation=1))
            contract_candidate = f.root / "coordinator" / "run-contract-candidate.json"
            publish_new(contract_candidate, run_contract)
            material_candidate = f.root / "coordinator" / "materials-candidate.json"
            publish_new(material_candidate, dict(contract=file_ref(contract_candidate), worker=None,
                reason="independently scoped no-Worker fixture", authority=[session["handoff"]]))
            def query(args, runtime, timeout=20):
                if args[:2] == ["orchestration", "run-show"]:
                    return dict(run=runs[0], coordinatorPolicy="strict-v1")
                return {"terminal": {"connected": True, "orphaned": False}}
            with patch("operator_startup.now", side_effect=lambda: f.base.clock.isoformat()), \
                    patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
                pending = handoff.task(lifecycle, "coordinator", call=query)
                self.assertFalse(pending["responsibility_accepted"])
                handoff.accept(lifecycle, "coordinator", "materials", call=query)
                completed = handoff.complete(lifecycle, "coordinator", "materials", file_ref(material_candidate), call=query)
                self.assertEqual(client.query(f.control, completed["completed"]).status, "confirmed")
                self.assertEqual(handoff.inspect(lifecycle, call=query)["next_owner"], "operator")
            if runtime_checks:
                self.runtime_chain(f, owner, identity, client, owner_ref, lifecycle, plan, run_contract, runs[0])
                return
            # Raw bytes placed in an owner-only final slot never gain confirmation.
            raw_final = Path(plan["state_root"]) / "operator-gate.json"
            publish_new(raw_final, {"not": "owner-published"})
            with self.assertRaisesRegex(ValueError, "startup_output_unconfirmed"):
                handoff.confirmed(plan, raw_final)
            with self.assertRaisesRegex(ValueError, "rpc_rejected"):
                handoff.publish(plan, Path(plan["state_root"]) / "first-contract.json", run_contract, actor="coordinator")
            client.stop(f.control)
            with self.assertRaisesRegex(ValueError, "rpc_rejected"):
                review_request(request, decision="approve", notes="not replayed", bootstrap_owner=owner_ref)

    def runtime_chain(self, f, owner, identity, client, owner_ref, lifecycle, plan, contract, run):
        import startup_handoff as handoff
        import startup_execution as execution
        from bootstrap_identity import BootstrapAdmissionClosed, OperatorInputPending
        from coordinator.test_coordinator_loop import LoopTests
        root = Path(plan["state_root"])
        def native(cli, runtime, args):
            if args[:2] in (["orchestration", "run-show"], ["orchestration", "run-current"]):
                return dict(run=run, coordinatorPolicy="strict-v1")
            if args[:2] == ["orchestration", "strict-caller-check"]:
                return f.base.tui.caller
            if args[:2] == ["orchestration", "check"]:
                return dict(count=0, messages=[])
            if args[:2] == ["orchestration", "worker-list"]:
                return dict(scope={"run": run["id"]}, workers=[], page={"total": 0, "hasMore": False})
            if args[:2] == ["terminal", "show"] and args[-1] in ("term_operator", "term_sender"):
                operator = args[-1] == "term_operator"
                return {"terminal": dict(handle=args[-1], incarnationId="inc_operator" if operator else "inc_sender",
                    worktreeId="workspace_operator" if operator else "workspace_sender", connected=True,
                    orphaned=False, agentIdentity=None, tabId="sender-tab", leafId="sender-leaf")}
            return f.base.tui.query(cli, runtime, args)
        def call(args, runtime, timeout=20):
            return native(contract["cli"]["path"], runtime, args)
        def action(name, candidate=None):
            actor = handoff.ACTIONS[name]
            identity.actor = actor
            with patch.dict(os.environ, ORCA_TERMINAL_HANDLE=contract[actor]["terminal"]):
                handoff.task(lifecycle, actor, call=call)
                handoff.accept(lifecycle, actor, name, call=call)
                return handoff.complete(lifecycle, actor, name, candidate, call=call)
        clock = lambda: f.base.clock.isoformat()
        with patch("coordinator_startup.native", side_effect=native), \
                patch("operator_session.observe_identity", return_value={"trust": "fixture"}), \
                patch("trae_tui.observe", return_value=f.base.observation), \
                patch("coordinator_startup.now", side_effect=clock), \
                patch("coordinator_tui_continue.now", side_effect=clock), \
                patch("coordinator_tui_prepare.now", side_effect=clock), \
                patch("operator_startup.now", side_effect=clock), patch("startup_handoff.now", side_effect=clock):
            review = f.base.tui.ref("runtime-review.json", dict(materials=file_ref(root / "materials.json"),
                decision="approve", notes="Independent original Operator fixture"))
            action("review", review)
            action("dispatch")
            admitted = handoff.admission(lifecycle, file_ref(root / "admission.json"))
            acceptance, checkpoint = LoopTests().fixture()
            source = dict(schema_version=2, run_id=run["id"], contract_sha256="a" * 64,
                          observed_at=clock(), **checkpoint)
            receipt = dict(ok=True, result=dict(consistent=True, decision=source["decision"],
                authority_sha256="b" * 64, context_sha256="c" * 64, contract_sha256="a" * 64),
                authority_check=dict(run_id=run["id"], checkpoint_sha256=digest(canonical(source)), schema_version=1,
                    grants_authority=False, authority_sha256="b" * 64, context_sha256="c" * 64,
                    status="consistent", error_code=None))
            data = dict(schema_version=1, contract=admitted["contract"], dispatch_gate=None,
                acceptance=f.base.tui.ref("bootstrap/runtime-acceptance.json", acceptance),
                source=f.base.tui.ref("bootstrap/runtime-source.json", source),
                receipt=f.base.tui.ref("bootstrap/runtime-checker.json", receipt),
                deadline=plan["runtime"]["deadline"], scheduler=plan["sender"],
                output_dir=str(Path(plan["continuation_publication"]).parent))
            action("continuation", f.base.tui.ref("runtime-init.json", data))
        config_ref = read_json(plan["continuation_publication"])
        config = parse(pinned(config_ref))
        args = dict(lifecycle=lifecycle, continuation=config_ref)
        # Expire only the startup admission; same owner, original pins and arm.
        with patch.object(identity, "check", side_effect=BootstrapAdmissionClosed("bootstrap_deadline_exceeded")), \
                patch.object(identity, "check_runtime", side_effect=lambda: TestIdentity.check(identity)), \
                patch.object(identity, "refresh_runtime", side_effect=lambda: TestIdentity.check(identity)):
            self.assertEqual(client.runtime_observe(f.control, **args)["state"], "ready")
            with self.assertRaisesRegex(ValueError, "bootstrap_deadline_exceeded"):
                client.active(f.control)
            self.assertTrue(owner.armed)
            self.assertFalse(execution.can_send(config))  # Manual stays observation-only.
            # Read-only timeout travels as a typed pending; no global STOP/rearm.
            with patch.object(identity, "refresh_runtime", side_effect=IdentityVerificationPending("bootstrap_native_identity_timeout")):
                with self.assertRaises(IdentityVerificationPending):
                    client.runtime_observe(f.control, **args)
                # Same signed RPC denial reaches the real deployment/monitor
                # admission path. No acceptance receipt or tick/send may occur.
                import operator_monitor_deploy as deploy
                import operator_monitor as monitor
                with patch("progress_watch.CLI", contract["cli"]["path"]), \
                        patch.object(monitor, "tick", side_effect=AssertionError("pending must not tick")) as tick:
                    deployment = deploy.prepare(config_ref, plan["monitor_state_root"], plan["deployment_dir"], call=call)
                    self.assertEqual(deploy.run(deployment, once=True), 3)
                self.assertEqual(tick.call_count, 0)
                self.assertEqual(read_json(Path(plan["monitor_state_root"]) / "status.json")["state"], "revalidation_pending")
                self.assertFalse((Path(plan["monitor_state_root"]) / "deployment-status.json").exists())
            self.assertTrue(owner.armed)
            self.assertEqual(client.runtime_observe(f.control, **args)["state"], "ready")
            self.runtime_input_review(f, identity, client, lifecycle, config_ref, contract, plan)
            identity.actor = "sender"
            for op in ("runtime-review-input", "runtime-attest-trigger"):
                with self.assertRaisesRegex(ValueError, "bootstrap_runtime_operator_required"):
                    client.rpc(op, **args, candidate=config_ref)
            with self.assertRaisesRegex(ValueError, "bootstrap_rpc_invalid"):
                client.rpc("runtime-observe", **args, scope="runtime")
            with patch("coordinator_tui_continue.now", return_value=(timestamp(plan["runtime"]["deadline"]) + timedelta(seconds=1)).isoformat()):
                with self.assertRaisesRegex(ValueError, "tui_continuation_deadline"):
                    client.runtime_observe(f.control, **args)
            self.assertTrue(owner.armed)
            with patch("bootstrap_control.io.now", return_value=plan["runtime"]["deadline"]):
                with self.assertRaisesRegex(ValueError, "startup_runtime_deadline_expired"):
                    client.runtime_observe(f.control, **args)
            def stop_during_native(_):
                self.assertFalse(owner.serial._is_owned())
                owner.stop(f.control)
            with patch.object(identity, "verify_run", side_effect=stop_during_native):
                with self.assertRaisesRegex(ValueError, "stopped"):
                    client.runtime_observe(f.control, **args)

    def runtime_input_review(self, f, identity, client, lifecycle, config_ref, contract, plan):
        from bootstrap_identity import OperatorInputPending
        request = f.base.tui.ref("runtime-request.json", dict(request_id="request-one", run=contract["run"],
            source=contract["coordinator"]["terminal"], input=contract["handoff"]))
        message = dict(id="message-one", from_handle=contract["coordinator"]["terminal"],
            to_handle=contract["operator"]["terminal"], run_id=contract["run"]["id"],
            payload=dict(kind="operator_runtime_review_v1", request=request))
        identity.mailbox = dict(count=1, messages=[message])
        args = dict(lifecycle=lifecycle, continuation=config_ref)
        with self.assertRaises(OperatorInputPending):
            client.runtime_observe(f.control, **args)
        handled = f.base.tui.ref("runtime-handled.json", dict(kind="operator_runtime_input_handled", request=request,
            message_sha256=digest(canonical(message)), run=contract["run"], operator=contract["operator"],
            decision="no-authority-change", notes="Reviewed exact request, scope unchanged", evidence=[contract["handoff"]]))
        candidate = f.base.tui.ref("runtime-input-review.json", dict(lifecycle=lifecycle,
            mailbox=f.base.tui.ref("runtime-mailbox.json", identity.mailbox), handled=[handled]))
        identity.actor = "operator"
        for index, bad in enumerate((dict(message, from_handle="wrong-source"), dict(message, payload="{}"), "not-an-envelope")):
            identity.mailbox = dict(count=1, messages=[bad])
            invalid = f.base.tui.ref("runtime-invalid-" + str(index) + ".json", dict(lifecycle=lifecycle,
                mailbox=f.base.tui.ref("runtime-invalid-mailbox-" + str(index) + ".json", identity.mailbox), handled=[handled]))
            with self.assertRaisesRegex(ValueError, "startup_operator_input_(source_unverified|unsupported)"):
                client.rpc("runtime-review-input", **args, candidate=invalid)
            with self.assertRaises(OperatorInputPending):
                client.runtime_observe(f.control, **args)
        identity.mailbox = dict(count=1, messages=[message])
        # Evidence validation can consume the lease after the first local
        # fence. The same target must remain unattempted until it is rechecked.
        import startup_runtime
        validate = startup_runtime.validate_input
        validations = []
        def expire_after_final_candidate(*values):
            validate(*values)
            validations.append(True)
        def leased_check():
            TestIdentity.check(identity)
            if len(validations) >= 2:
                raise IdentitySnapshotExpired("bootstrap_identity_snapshot_expired")
        with patch.object(startup_runtime, "validate_input", side_effect=expire_after_final_candidate), \
                patch.object(identity, "check_runtime", side_effect=leased_check):
            with self.assertRaisesRegex(ValueError, "bootstrap_identity_snapshot_expired"):
                client.rpc("runtime-review-input", **args, candidate=candidate)
        self.assertEqual(len(validations), 2)
        self.assertFalse(Path(startup_runtime.input_target(plan, identity.mailbox)).exists())
        result = client.rpc("runtime-review-input", **args, candidate=candidate)
        self.assertEqual(client.query(f.control, result).status, "confirmed")
        self.assertEqual(client.runtime_observe(f.control, **args)["state"], "ready")
        self.assertEqual(identity.mailbox["count"], 1)  # No consume/ACK.
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            client.rpc("runtime-review-input", **args, candidate=candidate)
        identity.mailbox = dict(count=1, messages=[dict(message, id="different")])
        with self.assertRaises(OperatorInputPending):
            client.runtime_observe(f.control, **args)
        identity.mailbox = dict(count=0, messages=[])

    def test_admitted_native_result_settles_after_stop_without_success_or_new_intent(self):
        with production() as (f, owner, identity, client, _):
            directory = f.root / "strict-start"
            directory.mkdir(mode=0o700)
            client.commit_new(f.control, actor="coordinator", target=str(directory / "create-intent.json"),
                              raw=b"{}", prerequisites=[], recheck=lambda: None)
            client.stop(f.control)
            result = client.rpc("settle", target=str(directory / "create-response.json"), raw=b'{"run":"test"}'.hex())
            self.assertEqual(result["status"], "confirmed")
            with self.assertRaisesRegex(ValueError, "rpc_rejected"):
                client.rpc("settle", target=str(directory / "created.json"), raw=b"{}".hex())
            self.assertFalse((directory / "created.json").exists())

    def test_mechanical_production_has_fixed_execution_intent_and_no_replay(self):
        with production() as (f, owner, identity, client, _):
            tool = RoleTool(f.control, client, "coordinator")
            try:
                action = tool.pull(30)
                with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_test"}), \
                        patch("trae_coordinator.native", side_effect=TimeoutError("unknown")) as native:
                    with self.assertRaises(TimeoutError):
                        tool.produce(action["intent"])
                    with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
                        tool.produce(action["intent"])
                native.assert_called_once()
            finally:
                tool.close()

    def test_native_identity_pins_sessions_launch_commitment_and_competing_input(self):
        from bootstrap_identity import NativeIdentity
        with production() as (f, owner, identity, client, _):
            anchor = process(os.getpid())
            roots = {"coordinator": dict(anchor, pid=101), "operator": dict(anchor, pid=102)}
            registration = f.base.tui.ref("production-registration.json", dict(schema_version=2,
                attempt_binding=f.control.attempt_binding, profile=str(f.base.tui.profile),
                log_root=str(f.base.tui.f.root), roles={
                    role: dict(provider="trae", process=roots[role],
                               session=(f.b["operator"]["session"] if role == "operator" else "coordinator-session"))
                    for role in roots}))
            observations = {}
            for role in roots:
                observations[role] = dict(session_id=(f.b["operator"]["session"] if role == "operator" else "coordinator-session"),
                    terminal=dict(incarnationId=f.b[role]["incarnation"], ptyId="pty", tabId="tab", leafId="leaf"),
                    transcript_path=str(f.base.tui.f.log),
                    launch_token_hash=digest(b"test-only-token"))
            def capture(query, options, **kwargs):
                role = "operator" if options["terminal_handle"] == "term_operator" else "coordinator"
                return {"identity": copy.deepcopy(observations[role])}
            def environment(target):
                role = "coordinator" if str(target) == "/proc/101/environ" else "operator"
                return ("ORCA_TERMINAL_HANDLE=" + f.b[role]["terminal"] +
                        "\0ORCA_PANE_KEY=tab:leaf\0ORCA_AGENT_LAUNCH_TOKEN=test-only-token\0").encode()
            original_read = Path.read_bytes
            def read(target):
                return environment(target) if str(target) in {"/proc/101/environ", "/proc/102/environ"} else original_read(target)
            with patch("bootstrap_identity.unchanged"), \
                    patch("bootstrap_identity.descendant", side_effect=ValueError("bootstrap_peer_wrong_process_tree")), \
                    patch("swarm_ledger.runtime_binding.capture", side_effect=capture), \
                    patch("trae_coordinator.native", return_value={"count": 0, "messages": []}) as query, \
                    patch.object(Path, "read_bytes", read):
                native = NativeIdentity(f.control, registration)
                start = time.monotonic()
                native.refresh()
                self.assertGreaterEqual(native.expires, start + 30)
                self.assertLessEqual(native.expires, time.monotonic() + 30)
                expires = native.expires
                native.check()
                self.assertEqual(native.expires, expires)
                with patch.object(native, "check_local", side_effect=lambda: setattr(native, "expires", 0)):
                    with self.assertRaises(IdentitySnapshotExpired):
                        native.check()
                with patch("bootstrap_identity.pinned", side_effect=ValueError("bootstrap_test_pin_changed")):
                    with self.assertRaisesRegex(ValueError, "test_pin_changed") as caught:
                        native.check()
                    self.assertNotIsInstance(caught.exception, IdentityVerificationPending)
                query.side_effect = subprocess.TimeoutExpired("private command", 5)
                with self.assertRaises(IdentityVerificationPending) as caught:
                    native.refresh()
                self.assertEqual(str(caught.exception), "bootstrap_native_identity_timeout")
                self.assertEqual(native.expires, 0)
                with patch.object(native, "check_local", side_effect=[
                        None, ValueError("bootstrap_test_pin_changed")]):
                    with self.assertRaisesRegex(ValueError, "test_pin_changed") as caught:
                        native.refresh()
                    self.assertNotIsInstance(caught.exception, IdentityVerificationPending)
                query.side_effect = subprocess.CalledProcessError(1, "private command")
                with self.assertRaisesRegex(ValueError, "native_identity_unverifiable") as caught:
                    native.refresh()
                self.assertNotIsInstance(caught.exception, IdentityVerificationPending)
                query.side_effect = None
                native.refresh()
                observations["operator"]["session_id"] = "replacement"
                with self.assertRaisesRegex(ValueError, "native_identity_changed"):
                    native.refresh()
                with self.assertRaisesRegex(ValueError, "snapshot_expired"):
                    native.check()
                observations["operator"]["session_id"] = f.b["operator"]["session"]
                observations["coordinator"]["launch_token_hash"] = "f" * 64
                with self.assertRaisesRegex(ValueError, "process_binding_unverifiable"):
                    native.refresh()
                observations["coordinator"]["launch_token_hash"] = digest(b"test-only-token")
                query.return_value = {"count": 1, "messages": [{}]}
                with self.assertRaisesRegex(ValueError, "competing_input"):
                    native.refresh()
                observations["operator"]["session_id"] = "replacement"
                with self.assertRaisesRegex(ValueError, "native_identity_changed"):
                    native.refresh()  # Competing input cannot mask a changed identity.
                observations["operator"]["session_id"] = f.b["operator"]["session"]
                # Same native roots/session/pins after the startup deadline.
                with patch("bootstrap_identity.now", return_value=(timestamp(f.b["deadline"]) + timedelta(seconds=1)).isoformat()):
                    native.refresh_runtime()
                    native.check_runtime()
                    self.assertEqual(native.mailbox["count"], 1)
                    with self.assertRaisesRegex(ValueError, "bootstrap_deadline_exceeded"):
                        native.check()
                    with patch("bootstrap_identity.pinned", side_effect=ValueError("bootstrap_test_pin_changed")):
                        with self.assertRaisesRegex(ValueError, "test_pin_changed"):
                            native.check_runtime()

    def test_s5_dangling_binding_never_falls_back_to_historical_entry(self):
        from bootstrap_s5 import protect
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "attempt-binding.json").symlink_to(root / "missing")
            called = []
            @protect("prepare", "operator")
            def entry(ref):
                called.append(ref)
            with self.assertRaisesRegex(ValueError, "bootstrap_owner_required"):
                entry(dict(path=str(root / "request.json"), sha256="a" * 64))
            self.assertFalse(called)

    def test_original_receipt_cannot_be_submitted_as_arbitrary_bytes(self):
        with production() as (f, owner, identity, client, _):
            tool = RoleTool(f.control, client, "coordinator")
            try:
                action = tool.pull(30)
                source = f.base.tui.ref("arbitrary-caller.json", f.base.tui.caller)
                with self.assertRaisesRegex(ValueError, "specialized_tool"):
                    tool.submit(action["intent"], source)
                self.assertFalse(Path(f.paths["caller_receipt"]).exists())
            finally:
                tool.close()

    def test_client_rejects_replacement_owner_key(self):
        from bootstrap_transport import Signer
        with production() as (f, owner, identity, client, _):
            ref = self.emit(f, client)
            client.public_key = Signer().public
            self.assertEqual(client.query(f.control, ref).status, "durability_unverified")

    def test_client_never_reads_proc_and_host_still_authenticates(self):
        original = Path.open
        caller_thread = threading.get_ident()
        def no_client_proc(path, *args, **kwargs):
            if threading.get_ident() == caller_thread and str(path).startswith("/proc/"):
                raise AssertionError("sandbox client attempted procfs access")
            return original(path, *args, **kwargs)
        with production() as (f, owner, identity, client, _), patch.object(Path, "open", no_client_proc):
            ref = self.emit(f, client)
            self.assertEqual(client.query(f.control, ref).status, "confirmed")
            with patch.object(identity, "authenticate", side_effect=ValueError("bootstrap_peer_wrong_process_tree")):
                with self.assertRaisesRegex(ValueError, "bootstrap_peer_wrong_process_tree"):
                    self.emit(f, client, "final_readiness")
            self.assertFalse(Path(f.paths["final_readiness"]).exists())

    def test_old_registration_is_not_silently_upgraded(self):
        with production() as (f, owner, identity, client, _):
            old = dict(client.owner, schema_version=1)
            old.pop("public_key")
            ref = f.base.tui.ref("old-owner.json", old)
            with self.assertRaisesRegex(ValueError, "owner_registration_mismatch"):
                AuthorityClient(f.control, ref)


if __name__ == "__main__":
    unittest.main()

class BusyRecheckInsideStepTests(unittest.TestCase):
    """A busy recheck inside step() dispatched nothing, so pull must stay pending."""

    def test_pull_returns_pending_when_a_busy_recheck_interrupts_the_step(self):
        from observation_budget import ObservationBusy

        with production() as (f, owner, identity, client, _):
            identity.actor = "operator"
            tool = RoleTool(f.control, client, "operator")
            try:
                with patch.object(tool, "step", side_effect=ObservationBusy()):
                    with patch.object(tool, "actionable", return_value=True):
                        result = tool.pull(2)
                self.assertEqual(result["state"], "pending")
                self.assertEqual(result["reason"], "owner_busy_not_executed")
                self.assertFalse(result["execution_authorized"])
            finally:
                tool.close()


class ProvedNonExecutionTests(unittest.TestCase):
    """A refused-before-dispatch commit must not wedge the production slot."""

    def test_classification_separates_non_execution_from_unknown_outcome(self):
        from bootstrap_tool import non_execution
        from observation_budget import ObservationBusy

        self.assertTrue(non_execution(ObservationBusy()))
        admitted = ValueError("bootstrap_rpc_rejected:bootstrap_owner_busy_not_executed")
        admitted.commit_state = "not_admitted"
        self.assertTrue(non_execution(admitted))
        for state in ("needs_reconcile", "unknown", "committed", None):
            unknown = ValueError("bootstrap_commit_unknown_requires_reconciliation")
            if state is not None:
                unknown.commit_state = state
            self.assertFalse(non_execution(unknown), state)
        self.assertFalse(non_execution(ValueError("bootstrap_owner_busy_not_executed")))

    def test_release_keeps_the_record_and_frees_the_slot(self):
        import tempfile
        from pathlib import Path
        from bootstrap_tool import NON_EXECUTION_RECORD_SUFFIX, release_not_executed

        with tempfile.TemporaryDirectory() as root:
            execution = Path(root) / "observe-execute.json"
            execution.write_text('{"kind":"strict_bootstrap_production_intent"}\n')
            record = release_not_executed(execution)
            self.assertFalse(execution.exists())
            self.assertEqual(record, str(execution) + NON_EXECUTION_RECORD_SUFFIX)
            self.assertEqual(Path(record).read_text(), '{"kind":"strict_bootstrap_production_intent"}\n')
            # A second release overwrites the record instead of raising.
            execution.write_text("{}\n")
            self.assertEqual(release_not_executed(execution), record)
            self.assertFalse(execution.exists())
