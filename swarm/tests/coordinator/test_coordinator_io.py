"""Real flock contention is retryable only at the acquisition boundary."""

import errno
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from coordinator_io import (FilePinChanged, LockBusy, bound_lock, canonical, digest, directory_lock,
                            file_ref, pinned, publish_new, replace_json, try_bound_lock)


class PinnedEvidenceTests(unittest.TestCase):
    def test_byte_and_canonical_json_mismatches_have_typed_redacted_diagnostic(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory).resolve() / "private-proof.json"
            publish_new(target, {"proof": 1})
            refs = ((file_ref(target), False),
                    ({"path": str(target), "sha256": digest(canonical({"proof": 1}))}, True))
            for ref, json_pin in refs:
                pinned(ref, json_pin=json_pin)
            replace_json(target, {"secret": "not for diagnostic"})
            for ref, json_pin in refs:
                with self.subTest(json_pin=json_pin), self.assertRaises(FilePinChanged) as caught:
                    pinned(ref, json_pin=json_pin)
                self.assertIsInstance(caught.exception, ValueError)
                self.assertEqual(str(caught.exception), "file_pin_changed")


class BoundLockTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.ref = {"path": "/test/config", "sha256": "a" * 64}

    def test_existing_only_missing_lock_does_not_create_it(self):
        with self.assertRaises(FileNotFoundError), directory_lock(self.root, "test", create=False):
            self.fail("missing lock")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_existing_only_contends_without_changing_lock_or_binding(self):
        with bound_lock(self.root, self.ref, "test"):
            before = {p.name: file_ref(p) for p in self.root.iterdir()}
            with self.assertRaises(LockBusy), directory_lock(self.root, "test", create=False):
                self.fail("competing holder")
            self.assertEqual(before, {p.name: file_ref(p) for p in self.root.iterdir()})
        with directory_lock(self.root, "test", create=False):
            pass

    def test_existing_only_rejects_replacement_before_unlock(self):
        with directory_lock(self.root, "test"):
            pass
        with self.assertRaisesRegex(ValueError, "existing_lock_changed"):
            with directory_lock(self.root, "test", create=False):
                replace_json(self.root / "test.lock", {})
        with directory_lock(self.root, "test", create=False):
            pass

    def test_existing_only_rejects_hardlink_and_fifo(self):
        publish_new(self.root / "other", b"")
        target = self.root / "test.lock"
        os.link(self.root / "other", target)
        with self.assertRaisesRegex(ValueError, "existing_lock_changed"), directory_lock(self.root, "test", create=False):
            self.fail("hardlink")
        target.unlink()  # Temporary test fixture only.
        os.mkfifo(target, 0o600)
        with self.assertRaisesRegex(ValueError, "invalid_lock_file"), directory_lock(self.root, "test", create=False):
            self.fail("fifo")

    def test_real_contention_then_release(self):
        with bound_lock(self.root, self.ref, "test"):
            with self.assertRaises(LockBusy), bound_lock(self.root, self.ref, "test"):
                self.fail("second writer")
            with try_bound_lock(self.root, self.ref, "test") as acquired:
                self.assertFalse(acquired)
        with try_bound_lock(self.root, self.ref, "test") as acquired:
            self.assertTrue(acquired)

    def test_only_acquisition_eagain_or_ewouldblock_is_busy(self):
        for number in (errno.EAGAIN, errno.EWOULDBLOCK):
            with self.subTest(errno=number), patch("coordinator_io.fcntl.flock", side_effect=OSError(number, "busy")):
                with try_bound_lock(self.root, self.ref, "test") as acquired:
                    self.assertFalse(acquired)

    def test_other_acquisition_errors_still_raise(self):
        for number in (errno.EACCES, errno.EPERM, errno.EIO, errno.EBADF, errno.EINTR):
            error = OSError(number, "failure")
            with self.subTest(errno=number), patch("coordinator_io.fcntl.flock", side_effect=error):
                with self.assertRaises(OSError) as caught, try_bound_lock(self.root, self.ref, "test"):
                    self.fail("failed lock yielded")
                self.assertIs(caught.exception, error)

    def test_body_errors_are_not_caught_and_lock_is_released(self):
        for kind in (BlockingIOError, LockBusy):
            error = kind(errno.EAGAIN, "body I/O failure")
            with self.subTest(kind=kind), self.assertRaises(kind) as caught:
                with try_bound_lock(self.root, self.ref, "test") as acquired:
                    self.assertTrue(acquired)
                    raise error
            self.assertIs(caught.exception, error)
            with bound_lock(self.root, self.ref, "test"):
                pass

    def test_binding_io_failure_is_not_contention(self):
        with patch("coordinator_io.read_json", side_effect=BlockingIOError(errno.EAGAIN, "read")):
            with self.assertRaises(BlockingIOError), try_bound_lock(self.root, self.ref, "test"):
                self.fail("binding failure yielded")

    def test_invalid_binding_and_permissions_are_not_contention(self):
        with bound_lock(self.root, self.ref, "test"):
            pass
        with self.assertRaisesRegex(ValueError, "test_config_changed"), try_bound_lock(self.root, {}, "test"):
            self.fail("changed binding")
        (self.root / "test.lock").chmod(0o644)
        with self.assertRaisesRegex(ValueError, "invalid_lock_file"), try_bound_lock(self.root, self.ref, "test"):
            self.fail("invalid permissions")


if __name__ == "__main__":
    unittest.main()
