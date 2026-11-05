"""Production socket/lock isolation with fake native identity, not live acceptance."""

import threading
import time
import unittest
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import shutil
from unittest.mock import patch

import blocking_io
from bootstrap_control import OwnerServer
from bootstrap_diagnostics import diagnose
from coordinator_io import directory_lock, LockBusy
from test_bootstrap_production import production


class OwnerIsolationTests(unittest.TestCase):
    def test_diagnostics_bypass_stalled_pin_and_reconcile_never_runs_concurrently(self):
        with production() as (fixture, owner, identity, client, _):
            entered, release = threading.Event(), threading.Event()
            original = OwnerServer.dispatch
            outcomes = []
            def stalled(server, connection, message):
                with blocking_io.stage("fixture_open", "/known/input"):
                    entered.set()
                    if not release.wait(5):
                        raise TimeoutError("fixture_timeout")
                return original(server, connection, message)
            def call():
                try:
                    outcomes.append(client.rpc("check"))
                except Exception as exc:
                    outcomes.append(exc)
            thread = threading.Thread(target=call)
            with patch.object(OwnerServer, "dispatch", new=stalled), patch.object(owner, "reconcile") as reconcile:
                try:
                    thread.start()
                    self.assertTrue(entered.wait(3))
                    # If diagnostics touch NAS/owner.bound/signing this fails.
                    with patch("bootstrap_control.io.pinned", side_effect=AssertionError("NAS read")), \
                            patch.object(owner, "bound", side_effect=AssertionError("owner fence")):
                        start = time.monotonic()
                        result = diagnose(client.owner["endpoint"])
                        self.assertLess(time.monotonic() - start, 1)
                    self.assertTrue(result["diagnostic_only"])
                    self.assertFalse(result["durable"])
                    self.assertEqual(result["state"], "busy")
                    self.assertEqual(result["operation"]["events"][-1]["stage"], "fixture_open")
                    # Use another client: AuthorityClient deadline state is per caller.
                    from bootstrap_control import AuthorityClient
                    observer = AuthorityClient(fixture.control, client.owner_ref)
                    from observation_budget import ObservationBusy
                    with observer.polling(time.monotonic() + 3):
                        with self.assertRaises(ObservationBusy):
                            observer.rpc("check")
                    with self.assertRaises(ObservationBusy):
                        observer.query(fixture.control, client.owner_ref)
                    with self.assertRaisesRegex(ValueError, "owner_busy_not_executed"):
                        observer.rpc("reconcile", target=client.owner_ref)
                    reconcile.assert_not_called()
                    with self.assertRaises(LockBusy), directory_lock(owner.root, "owner", create=False):
                        self.fail("second owner acquired singleton")
                finally:
                    release.set()
                    thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(outcomes, [{"actor": identity.actor}])
            idle = diagnose(client.owner["endpoint"])
            self.assertEqual(idle["state"], "idle")
            self.assertIsNone(idle["operation"])

    def test_cli_close_rejected_before_dispatch_keeps_real_singleton(self):
        import bootstrap_tool as tool
        import bootstrap_control as control
        with production() as (fixture, owner, identity, client, _):
            entered, release = threading.Event(), threading.Event()
            local, servers, outcomes = threading.local(), [], []
            original_handle, original_pin = OwnerServer._handle, control.io.pinned
            def handle(server, connection):
                local.server = True
                servers.append(server)
                return original_handle(server, connection)
            def pin(ref):
                if getattr(local, "server", False):
                    entered.set()
                    if not release.wait(5):
                        raise TimeoutError("fixture_timeout")
                return original_pin(ref)
            def call():
                try:
                    outcomes.append(client.rpc("check"))
                except Exception as exc:
                    outcomes.append(exc)
            worker = threading.Thread(target=call)
            with patch.object(OwnerServer, "_handle", new=handle), patch.object(control.io, "pinned", side_effect=pin):
                try:
                    worker.start()
                    self.assertTrue(entered.wait(3))
                    self.assertTrue(owner.serial.acquire(blocking=False))
                    owner.serial.release()  # The stalled request does not hold serial.
                    output = io.StringIO()
                    with patch.object(tool, "CommitOwner", return_value=owner), \
                            patch.object(tool, "NativeIdentity", return_value=identity), \
                            patch.object(tool, "OwnerServer", return_value=servers[0]), \
                            patch.object(servers[0], "serve"), \
                            patch.object(owner, "close", wraps=owner.close) as close, redirect_stdout(output):
                        self.assertEqual(tool.cli_main(["serve", "--execute", "--binding",
                            fixture.control.attempt_binding["path"], "--binding-sha256",
                            fixture.control.attempt_binding["sha256"], "--endpoint", client.owner["endpoint"]]), 2)
                    close.assert_not_called()
                    self.assertFalse(owner.closed)
                    with self.assertRaises(LockBusy), directory_lock(owner.root, "owner", create=False):
                        self.fail("CLI released singleton while old request remains live")
                    record = json.loads(output.getvalue().splitlines()[-1])["diagnostics"]
                    self.assertFalse(record["durable"])
                    self.assertTrue(record["requires_reconciliation"])
                    target = Path(record["target"])
                    self.addCleanup(shutil.rmtree, target.parent)
                    saved = json.loads(target.read_bytes())
                    self.assertEqual(target.name, "owner-close-rejected.json")
                    self.assertFalse(saved["execution_cancelled"])
                    self.assertTrue(saved["archive_pending"])
                finally:
                    release.set()
                    worker.join(5)
            self.assertFalse(worker.is_alive())
            self.assertEqual(outcomes, [{"actor": identity.actor}])

    def test_close_during_request_does_not_release_owner_lock(self):
        with production() as (fixture, owner, identity, client, _):
            entered, release = threading.Event(), threading.Event()
            servers, outcomes = [], []
            original = OwnerServer.dispatch
            def stalled(server, connection, message):
                servers.append(server)
                entered.set()
                release.wait(5)
                return original(server, connection, message)
            def call():
                try:
                    outcomes.append(client.rpc("check"))
                except Exception as exc:
                    outcomes.append(exc)
            thread = threading.Thread(target=call)
            with patch.object(OwnerServer, "dispatch", new=stalled):
                try:
                    thread.start()
                    self.assertTrue(entered.wait(3))
                    with self.assertRaisesRegex(ValueError, "busy_requires_reconciliation"):
                        servers[0].close()
                    self.assertFalse(owner.closed)
                    self.assertEqual(diagnose(client.owner["endpoint"])["state"], "busy")
                    with self.assertRaises(LockBusy), directory_lock(owner.root, "owner", create=False):
                        self.fail("singleton released early")
                finally:
                    release.set()
                    thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(outcomes, [{"actor": identity.actor}])

    def test_failed_request_clears_active_diagnostics(self):
        with production() as (_, _, _, client, _):
            with patch.object(OwnerServer, "dispatch", side_effect=ValueError("bootstrap_fixture_failed")):
                with self.assertRaisesRegex(ValueError, "bootstrap_fixture_failed"):
                    client.rpc("check")
            result = diagnose(client.owner["endpoint"])
            self.assertEqual(result["state"], "idle")
            self.assertIsNone(result["operation"])


if __name__ == "__main__":
    unittest.main()
