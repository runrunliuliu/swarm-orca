"""Fault windows on real local files, lock and isolated processes, no Agent."""

from dataclasses import replace
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest

from bootstrap_control_fixture import consume_fixture, serve_fixture
from bootstrap_protocol import ControlBinding
from coordinator_io import digest, directory_lock, LockBusy


class BootstrapControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bootstrap-primitives-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        (self.root / "owner.lock").touch(mode=0o600)
        self.context = multiprocessing.get_context("spawn")
        self.control = ControlBinding(dict(path=str(self.root / "attempt-binding.json"), sha256="a" * 64),
                                      "fixture-control", "generation-1")
        self.target = str(self.root / "marker.json")
        self.request = str(self.root / "strict-config-request.json")
        self.start_intent = str(self.root / "strict-start-intent.json")
        self.raw = b'{"fixture":"immutable","created_at":"fixed"}\n'
        self.ref = dict(path=self.target, sha256=digest(self.raw))
        self.children = []
        self.addCleanup(self.cleanup_children)

    def cleanup_children(self):
        for child, pipe, release in self.children:
            if child.is_alive():
                # A terminated Event waiter cannot acknowledge notify_all;
                # never signal synchronization objects owned by a dead child.
                release.set()
                try:
                    pipe.send(dict(op="shutdown"))
                except (OSError, BrokenPipeError):
                    pass
                child.join(2)
            if child.is_alive():
                child.terminate()  # only our isolated fixture child
                child.join(2)
            pipe.close()

    def owner(self, fault="none", control=None):
        client, server = self.context.Pipe()
        hit, release = self.context.Event(), self.context.Event()
        child = self.context.Process(target=serve_fixture, args=(server, str(self.root), control or self.control,
            {self.target: "operator", self.request: "coordinator", self.start_intent: "coordinator"}, hit, release, fault))
        child.start()
        server.close()
        self.children.append((child, client, release))
        self.assertTrue(client.poll(5), "owner startup timeout")
        status = client.recv()
        return child, client, hit, release, status

    def call(self, pipe, op, **kwargs):
        pipe.send(dict(op=op, **kwargs))
        self.assertTrue(pipe.poll(7), "fixture response timeout")
        return pipe.recv()

    def armed(self, fault="none"):
        owner = self.owner(fault)
        self.assertEqual(owner[-1], "owner_ready_closed")
        self.assertEqual(self.call(owner[1], "arm"), "ok")
        return owner

    def start_commit(self, pipe, **kwargs):
        args = dict(op="commit_new", actor="operator", target=self.target, raw=self.raw, prerequisites=[])
        args.update(kwargs)
        return self.call(pipe, "start", name="commit", args=args)

    def consume(self, pipe):
        result, sender = self.context.Pipe(duplex=False)
        child = self.context.Process(target=consume_fixture, args=(pipe, str(self.root), self.ref, sender))
        child.start()
        sender.close()
        try:
            self.assertTrue(result.poll(5), "consumer timeout")
            receipt = result.recv()
            child.join(5)
            self.assertEqual(child.exitcode, 0)
            self.assertNotEqual(receipt["pid"], os.getpid())
            self.assertTrue(receipt["unchanged"])
            return receipt
        finally:
            if child.is_alive():
                child.terminate()
                child.join(2)
            result.close()

    def test_consumer_sees_link_before_fsync_but_never_confirmation(self):
        owner, pipe, hit, release, _ = self.armed("pause_dir")
        self.start_commit(pipe)
        self.assertTrue(hit.wait(5))
        self.assertEqual(Path(self.target).read_bytes(), self.raw)
        before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.iterdir()}
        self.assertEqual(self.call(pipe, "query", target=self.ref), "durability_unverified")
        consumed = self.consume(pipe)
        self.assertEqual(consumed["status"], "durability_unverified")
        self.assertNotEqual(consumed["pid"], owner.pid)
        self.assertEqual(before, {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.iterdir()})
        release.set()
        self.assertEqual(self.call(pipe, "join", name="commit"), "confirmed")
        self.assertEqual(self.call(pipe, "query", target=self.ref), "confirmed")
        self.assertEqual(self.consume(pipe)["status"], "confirmed")

    def test_fsync_error_visible_file_requires_exact_execute_reconciliation(self):
        _, pipe, _, _, _ = self.armed("dir_error")
        self.start_commit(pipe)
        self.assertIn("fixture_directory_fsync_failure", self.call(pipe, "join", name="commit"))
        self.assertEqual(self.call(pipe, "query", target=self.ref), "durability_unverified")
        before = Path(self.target).stat()
        self.assertIn("unverified", self.call(pipe, "reconcile", target=self.ref, checks_ok=False))
        self.assertEqual(self.call(pipe, "query", target=self.ref), "durability_unverified")
        self.assertEqual(self.call(pipe, "reconcile", target=self.ref), "confirmed")
        after = Path(self.target).stat()
        self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns))
        self.assertEqual(Path(self.target).read_bytes(), self.raw)
        self.assertIn("not_armed", self.call(pipe, "commit_new", actor="coordinator", target=self.request,
                                            raw=b"request", prerequisites=[self.ref]))

    def test_owner_crash_releases_lock_not_confirmation_new_generation_closed(self):
        child, pipe, hit, _, _ = self.armed("pause_dir")
        self.start_commit(pipe)
        self.assertTrue(hit.wait(5))
        child.terminate()
        child.join(5)
        self.assertFalse(child.is_alive())
        with directory_lock(self.root, "owner", create=False):
            pass  # Availability after a crash says nothing about durable commit.
        generation = replace(self.control, generation="generation-2")
        _, successor, _, _, status = self.owner(control=generation)
        self.assertEqual(status, "owner_ready_closed")
        self.assertEqual(self.call(successor, "query", target=self.ref), "durability_unverified")
        self.assertIn("not_armed", self.call(successor, "commit_new", actor="coordinator", target=self.request,
                                            raw=b"request", prerequisites=[]))
        self.assertIn("control_generation_mismatch", self.call(successor, "arm", control=self.control))
        self.assertEqual(self.call(successor, "reconcile", target=self.ref), "confirmed")
        self.assertEqual(self.call(successor, "query", target=self.ref, control=self.control), "durability_unverified")
        self.assertEqual(self.call(successor, "arm"), "ok")
        self.assertEqual(self.call(successor, "commit_new", actor="coordinator", target=self.request,
                                   raw=b"request", prerequisites=[self.ref]), "confirmed")

    def test_crash_after_actual_fsync_still_loses_memory_confirmation(self):
        child, pipe, hit, _, _ = self.armed("crash_after_fsync")
        self.start_commit(pipe)
        self.assertTrue(hit.wait(5))
        child.join(5)
        self.assertEqual(child.exitcode, 71)
        self.assertEqual(self.consume(pipe)["status"], "durability_unverified")
        _, successor, _, _, _ = self.owner(control=replace(self.control, generation="generation-2"))
        self.assertEqual(self.call(successor, "query", target=self.ref), "durability_unverified")
        self.assertEqual(self.call(successor, "reconcile", target=self.ref), "confirmed")

    def test_stop_first_rejects_request_and_remains_closed_after_restart(self):
        child, pipe, _, _, _ = self.armed()
        self.assertEqual(self.call(pipe, "stop"), "ok")
        self.assertIn("stopped", self.call(pipe, "commit_new", actor="coordinator", target=self.request,
                                          raw=b"request", prerequisites=[]))
        self.assertFalse(Path(self.request).exists())
        pipe.send(dict(op="shutdown"))
        child.join(5)
        _, successor, _, _, _ = self.owner(control=replace(self.control, generation="generation-2"))
        self.assertIn("stopped", self.call(successor, "arm"))
        self.assertIn("stopped", self.call(successor, "reconcile", target=self.ref))

    def test_commit_first_then_stop_keeps_fact_but_rejects_downstream(self):
        _, pipe, hit, release, _ = self.armed("pause_dir")
        self.start_commit(pipe)
        self.assertTrue(hit.wait(5))
        self.assertEqual(self.call(pipe, "start", name="stop", args=dict(op="stop")), "started")
        release.set()
        self.assertEqual(self.call(pipe, "join", name="commit"), "confirmed")
        self.assertEqual(self.call(pipe, "join", name="stop"), "ok")
        self.assertEqual(self.call(pipe, "query", target=self.ref), "confirmed")
        self.assertIn("stopped", self.call(pipe, "commit_new", actor="coordinator", target=self.request,
                                          raw=b"request", prerequisites=[self.ref]))

    def test_failed_stop_persistence_still_closes_live_owner(self):
        _, pipe, _, _, _ = self.armed("dir_error")
        self.assertIn("fsync_failure", self.call(pipe, "stop"))
        self.assertIn("stopped", self.call(pipe, "arm"))
        self.start_commit(pipe)
        self.assertIn("stopped", self.call(pipe, "join", name="commit"))
        self.assertFalse(Path(self.target).exists())

    def test_fixed_owner_lock_excludes_second_authority(self):
        self.armed()
        with self.assertRaises(LockBusy):
            with directory_lock(self.root, "owner", create=False):
                self.fail("second owner admitted")
        child, _, _, _, status = self.owner()
        self.assertIn("LockBusy", status)
        child.join(5)

    def test_absent_wrong_role_unconfirmed_dependency_and_no_overwrite(self):
        _, pipe, _, _, _ = self.armed()
        self.assertEqual(self.call(pipe, "query", target=self.ref), "not_committed")
        self.assertIn("role_or_path_mismatch", self.call(pipe, "commit_new", actor="operator", target=self.request,
                                                        raw=b"request", prerequisites=[]))
        self.assertIn("prerequisite_unconfirmed", self.call(pipe, "commit_new", actor="coordinator", target=self.request,
                                                           raw=b"request", prerequisites=[self.ref]))
        self.start_commit(pipe)
        self.assertEqual(self.call(pipe, "join", name="commit"), "confirmed")
        self.start_commit(pipe, raw=b"different")
        self.assertIn("FileExistsError", self.call(pipe, "join", name="commit"))
        self.assertEqual(Path(self.target).read_bytes(), self.raw)
        changed = dict(self.ref, sha256=digest(b"different"))
        self.assertEqual(self.call(pipe, "query", target=changed), "durability_unverified")
        self.assertIn("FilePinChanged", self.call(pipe, "reconcile", target=changed))

    def test_live_check_failure_inside_admission_prevents_request(self):
        _, pipe, _, _, _ = self.armed()
        self.assertIn("unverified", self.call(pipe, "commit_new", actor="coordinator", target=self.request,
                                             raw=b"request", prerequisites=[], checks_ok=False))
        self.assertFalse(Path(self.request).exists())

    def test_before_link_failure_is_not_committed_and_closes_admission(self):
        _, pipe, _, _, _ = self.armed("link_error")
        self.start_commit(pipe)
        self.assertIn("fixture_link_failure", self.call(pipe, "join", name="commit"))
        self.assertEqual(self.call(pipe, "query", target=self.ref), "not_committed")
        self.assertIn("not_armed", self.call(pipe, "commit_new", actor="coordinator", target=self.request,
                                            raw=b"request", prerequisites=[]))

    def test_s5_same_authority_retains_stop_responsibility(self):
        _, pipe, _, _, _ = self.armed()
        self.assertEqual(self.call(pipe, "commit_new", actor="coordinator", target=self.request,
                                   raw=b"request", prerequisites=[]), "confirmed")
        request_ref = dict(path=self.request, sha256=digest(b"request"))
        self.assertEqual(self.call(pipe, "query", target=request_ref), "confirmed")
        self.assertEqual(self.call(pipe, "stop"), "ok")
        self.assertIn("stopped", self.call(pipe, "commit_new", actor="coordinator", target=self.start_intent,
                                          raw=b"intent only, no native call", prerequisites=[request_ref]))
        self.assertFalse(Path(self.start_intent).exists())


if __name__ == "__main__":
    unittest.main()
