"""P0 exit classification on the real owner socket: not_admitted/committed/unknown.

Every case below runs the production CommitOwner, Unix socket, peer credentials,
signing, fsync and confirmation query. The only substitutions are the explicit
test identity (native provider identity is never real here) and client-side reply
loss, which is exactly the condition being classified. No owner stub is used.
"""

from pathlib import Path
import threading
import unittest
from unittest.mock import patch

from bootstrap_s5 import COMMIT_UNKNOWN, CONFIRMATION_PENDING, commit_confirmed
from bootstrap_transport import safe_reason
from coordinator_io import file_ref
import bootstrap_control
from bootstrap import test_bootstrap_production as production_tests


def commit(authority, control, target, raw, *, actor="coordinator", prerequisites=(), retry_seconds=5):
    return commit_confirmed(authority, control, actor=actor, target=target, raw=raw,
                            prerequisites=list(prerequisites), recheck=lambda: None,
                            retry_seconds=retry_seconds)


class held_executor:
    """Hold the owner's single executor inside one authenticated request.

    A heartbeat is already dispatched when `entered` fires, so whatever the
    caller does next is rejected as `bootstrap_owner_busy_not_executed`, i.e.
    before dispatch: the provable non-execution boundary.
    """

    def __init__(self, identity, client):
        self.identity, self.client = identity, client
        self.original = identity.check
        self.entered, self.release = threading.Event(), threading.Event()

    def check(self):
        self.original()
        if not self.entered.is_set():
            self.entered.set()
            self.release.wait(10)

    def hold(self):
        try:
            self.client.heartbeat(self.client.control, self.identity.actor)
        except (OSError, ValueError):
            pass  # Only the held executor matters; its reply is not the subject.

    def __enter__(self):
        self.patcher = patch.object(self.identity, "check", side_effect=self.check)
        self.patcher.start()
        self.thread = threading.Thread(target=self.hold)
        self.thread.start()
        assert self.entered.wait(5), "owner executor never entered the held request"
        return self

    def __exit__(self, *exc_info):
        self.release.set()
        self.thread.join(10)
        self.patcher.stop()
        assert not self.thread.is_alive(), "held request did not drain"
        return False


class CommitStateTests(unittest.TestCase):
    def test_success_and_absence_are_explicit_states(self):
        with production_tests.production() as (f, owner, identity, client, _):
            ref = commit(client, f.control, f.paths["caller_receipt"], b"state-committed")
            reply = client.query(f.control, ref)
            self.assertEqual((reply.status, reply.state), ("confirmed", "committed"))
            absent = dict(path=f.paths["final_readiness"], sha256="0" * 64)
            reply = client.query(f.control, absent)
            self.assertEqual((reply.status, reply.state), ("not_committed", "not_admitted"))

    def test_pre_admission_refusal_is_not_admitted_and_never_writes(self):
        with production_tests.production() as (f, owner, identity, client, _):
            identity.actor = "operator"
            with self.assertRaises(ValueError) as caught:
                commit(client, f.control, f.paths["caller_receipt"], b"wrong role", actor="operator")
            self.assertEqual((caught.exception.commit_state, caught.exception.may_replay),
                             ("not_admitted", True))
            self.assertIn("role_or_path_mismatch", safe_reason(caught.exception))
            self.assertFalse(Path(f.paths["caller_receipt"]).exists())
            identity.actor = "coordinator"
            client.stop(f.control)
            with self.assertRaises(ValueError) as caught:
                commit(client, f.control, f.paths["caller_receipt"], b"after stop")
            self.assertEqual((caught.exception.commit_state, caught.exception.may_replay),
                             ("not_admitted", True))
            self.assertIn("stopped", safe_reason(caught.exception))
            self.assertFalse(Path(f.paths["caller_receipt"]).exists())

    def test_attempted_but_unpublished_is_a_reconcile_outcome_not_a_retry(self):
        with production_tests.production() as (f, owner, identity, client, _):
            target = f.paths["caller_receipt"]
            with patch("coordinator_io.fsync_dir", side_effect=OSError("test barrier")):
                with self.assertRaises(ValueError) as caught:
                    commit(client, f.control, target, b"visible but unconfirmed")
            # The bytes may exist; the owner cannot prove its own publish completed.
            self.assertEqual((caught.exception.commit_state, caught.exception.may_replay),
                             ("unknown", False))
            ref = file_ref(target)
            reply = client.query(f.control, ref)
            self.assertEqual((reply.status, reply.state), ("durability_unverified", "needs_reconcile"))
            before = (Path(target).stat().st_ino, Path(target).stat().st_mtime_ns)
            with self.assertRaises(ValueError) as caught:
                commit(client, f.control, target, b"visible but unconfirmed")
            # The owner's own intent record rejects the replay; the client never
            # overwrites, and the outcome stays a reconciliation case.
            self.assertEqual(str(caught.exception), "bootstrap_commit_requires_reconciliation")
            self.assertEqual(caught.exception.commit_state, "needs_reconcile")
            self.assertFalse(caught.exception.may_replay)
            self.assertEqual((Path(target).stat().st_ino, Path(target).stat().st_mtime_ns), before)
            identity.actor = "operator"
            self.assertEqual(client.rpc("reconcile", target=ref)["status"], "confirmed")
            self.assertEqual((Path(target).stat().st_ino, Path(target).stat().st_mtime_ns), before)
            self.assertEqual(client.query(f.control, ref).state, "committed")

    def test_busy_before_dispatch_is_retried_in_place_to_one_publication(self):
        with production_tests.production() as (f, owner, identity, client, _):
            publications = []
            original = bootstrap_control.io.publish_new

            def publish(target, raw):
                publications.append(str(target))
                return original(target, raw)

            with held_executor(identity, client) as held:
                timer = threading.Timer(0.5, held.release.set)
                timer.start()
                try:
                    with patch("bootstrap_control.io.publish_new", side_effect=publish):
                        ref = commit(client, f.control, f.paths["caller_receipt"], b"busy then once")
                finally:
                    timer.cancel()
                    held.release.set()
            self.assertEqual(publications, [f.paths["caller_receipt"]])
            self.assertEqual(client.query(f.control, ref).state, "committed")

    def test_exhausted_busy_reports_unknown_and_publishes_nothing(self):
        with production_tests.production() as (f, owner, identity, client, _):
            publications = []
            with held_executor(identity, client):
                with patch("bootstrap_control.io.publish_new",
                           side_effect=lambda *args: publications.append(args)):
                    with self.assertRaises(ValueError) as caught:
                        commit(client, f.control, f.paths["caller_receipt"], b"never dispatched",
                               retry_seconds=-1)
            # The last reply was retryable, but the budget is spent: report the
            # unknown class, never a bare busy code that a caller could replay.
            self.assertEqual(str(caught.exception), COMMIT_UNKNOWN)
            self.assertEqual((caught.exception.commit_state, caught.exception.may_replay),
                             ("unknown", False))
            self.assertEqual(publications, [])
            self.assertFalse(Path(f.paths["caller_receipt"]).exists())

    def test_lost_confirmation_reply_reports_pending_without_recommitting(self):
        from observation_budget import ObservationBusy
        with production_tests.production() as (f, owner, identity, client, _):
            calls = []
            original = client.commit_new

            def counted(*args, **kwargs):
                calls.append(kwargs["target"])
                return original(*args, **kwargs)

            with patch.object(client, "commit_new", side_effect=counted), \
                    patch.object(client, "query", side_effect=ObservationBusy()):
                with self.assertRaises(ValueError) as caught:
                    commit(client, f.control, f.paths["caller_receipt"], b"committed once",
                           retry_seconds=-1)
            self.assertEqual(str(caught.exception), CONFIRMATION_PENDING)
            self.assertEqual(calls, [f.paths["caller_receipt"]])
            self.assertEqual(client.query(f.control, file_ref(f.paths["caller_receipt"])).state, "committed")

    def test_lost_commit_reply_is_unknown_and_never_retried(self):
        with production_tests.production() as (f, owner, identity, client, _):
            with patch.object(client, "_rpc", side_effect=TimeoutError("test reply lost")) as rpc, \
                    patch("bootstrap_control.io.publish_new",
                          side_effect=AssertionError("must not publish")):
                with self.assertRaises(ValueError) as caught:
                    commit(client, f.control, f.paths["caller_receipt"], b"unknown outcome")
            self.assertEqual(rpc.call_count, 1)
            self.assertEqual(caught.exception.commit_state, "unknown")
            self.assertFalse(caught.exception.may_replay)
            self.assertIn("timeout", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
