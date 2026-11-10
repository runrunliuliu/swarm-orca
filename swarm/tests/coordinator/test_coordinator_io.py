"""Real flock contention is retryable only at the acquisition boundary."""

import errno
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import coordinator_io
from coordinator_io import (FilePinChanged, LockBusy, bound_lock, canonical, clear_pin_cache, digest,
                            directory_lock, file_ref, pinned, publish_new, read_bytes, replace_json,
                            try_bound_lock)

_REAL_OPEN = os.open


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


class VerifiedReadReuseTests(unittest.TestCase):
    """A retained identity may save syscalls; it may never mask a changed file.

    Timestamps are quantized (1 ms on this host, 1 s on coarse filesystems), so a
    same-size rewrite inside one tick carries an identical mtime and ctime. The
    default settle window therefore refuses a freshly written file; the reuse
    tests below set the window to zero and cross a tick explicitly, which is the
    condition under which reuse is allowed at all.
    """

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.target = self.root / "pinned.bin"
        self.target.write_bytes(b"aaaa")
        clear_pin_cache()
        self.addCleanup(clear_pin_cache)
        settle = patch.object(coordinator_io, "_PIN_CACHE_SETTLE_NS", 0)
        settle.start()
        self.addCleanup(settle.stop)
        # These cases assert what a retained identity must never mask, so reuse has
        # to be on whatever the ambient environment says.
        state = patch.object(coordinator_io, "_pin_cache_state", coordinator_io._PIN_CACHE_DEFAULT)
        state.start()
        self.addCleanup(state.stop)

    def write_in_place(self, value, *, restore=None):
        time.sleep(0.005)  # Cross one timestamp quantum so the stamps can move.
        with open(self.target, "r+b") as stream:
            stream.write(value)
        if restore is not None:
            os.utime(self.target, ns=restore)

    def test_fresh_file_is_not_retained_until_it_settles(self):
        with patch.object(coordinator_io, "_PIN_CACHE_SETTLE_NS", 1_000_000_000):
            self.assertEqual(read_bytes(str(self.target)), b"aaaa")
        self.assertEqual(coordinator_io._pin_cache, {})

    def test_reuse_saves_the_open_and_keeps_the_digest(self):
        with patch.object(os, "open", wraps=_REAL_OPEN) as opened:
            first = file_ref(self.target)
            after_first = opened.call_count
            second = file_ref(self.target)
            self.assertEqual(opened.call_count, after_first)
        self.assertEqual(first, second)
        self.assertEqual(second["sha256"], digest(b"aaaa"))
        self.assertEqual(len(coordinator_io._pin_cache), 1)
        self.assertEqual(read_bytes(str(self.target)), b"aaaa")

    def test_same_size_rewrite_is_not_reused(self):
        self.assertEqual(read_bytes(str(self.target)), b"aaaa")
        self.assertEqual(len(coordinator_io._pin_cache), 1)
        self.write_in_place(b"bbbb")
        self.assertEqual(read_bytes(str(self.target)), b"bbbb")
        self.assertEqual(file_ref(self.target)["sha256"], digest(b"bbbb"))

    def test_rewrite_with_restored_mtime_is_not_reused(self):
        before = os.stat(self.target)
        self.assertEqual(read_bytes(str(self.target)), b"aaaa")
        self.assertEqual(len(coordinator_io._pin_cache), 1)
        self.write_in_place(b"bbbb", restore=(before.st_atime_ns, before.st_mtime_ns))
        after = os.stat(self.target)
        self.assertEqual((after.st_size, after.st_mtime_ns), (before.st_size, before.st_mtime_ns))
        self.assertNotEqual(after.st_ctime_ns, before.st_ctime_ns)
        self.assertEqual(read_bytes(str(self.target)), b"bbbb")
        with self.assertRaises(FilePinChanged):
            pinned({"path": str(self.target), "sha256": digest(b"aaaa")})

    def test_symlink_replacement_is_refused_not_reused(self):
        self.assertEqual(read_bytes(str(self.target)), b"aaaa")
        moved = self.root / "moved.bin"
        self.target.rename(moved)
        self.target.symlink_to(moved)
        with self.assertRaisesRegex(ValueError, "canonical_nonsymlink_path_required"):
            read_bytes(str(self.target))
        with self.assertRaisesRegex(ValueError, "canonical_nonsymlink_path_required"):
            file_ref(self.target)

    def test_parent_directory_symlink_is_refused(self):
        (self.root / "nested").mkdir()
        inner = self.root / "nested" / "pinned.bin"
        inner.write_bytes(b"cccc")
        self.assertEqual(read_bytes(str(inner)), b"cccc")
        (self.root / "nested").rename(self.root / "moved")
        (self.root / "nested").symlink_to(self.root / "moved")
        with self.assertRaisesRegex(ValueError, "canonical_nonsymlink_path_required"):
            read_bytes(str(inner))

    def test_truncation_during_read_is_reported_and_not_retained(self):
        real_fstat = os.fstat

        class Lying:
            def __init__(self, info, extra):
                self.__dict__.update({name: getattr(info, name) for name in (
                    "st_mode", "st_dev", "st_ino", "st_mtime_ns", "st_ctime_ns")})
                self.st_size = info.st_size + extra

        def fstat(fd):
            return Lying(real_fstat(fd), 4)

        with patch.object(coordinator_io.os, "fstat", fstat):
            with self.assertRaisesRegex(ValueError, "file_truncated"):
                read_bytes(str(self.target))
        self.assertEqual(coordinator_io._pin_cache, {})
        self.assertEqual(read_bytes(str(self.target)), b"aaaa")

    def test_non_regular_entry_falls_back_to_the_strict_error(self):
        fifo = self.root / "fifo"
        self.assertEqual(read_bytes(str(self.target)), b"aaaa")
        os.mkfifo(fifo)
        with self.assertRaisesRegex(ValueError, "wrong_path_type"):
            read_bytes(str(fifo))

    def test_cross_process_same_size_write_is_not_reused(self):
        self.assertEqual(read_bytes(str(self.target)), b"aaaa")
        self.assertEqual(len(coordinator_io._pin_cache), 1)
        time.sleep(0.005)
        subprocess.run([sys.executable, "-c",
                        "import sys;open(sys.argv[1],'r+b').write(b'zzzz')", str(self.target)],
                       check=True)
        self.assertEqual(read_bytes(str(self.target)), b"zzzz")

    def test_disabled_cache_reads_every_time(self):
        with patch.object(coordinator_io, "_pin_cache_state", 0):
            with patch.object(os, "open", wraps=_REAL_OPEN) as opened:
                self.assertEqual(read_bytes(str(self.target)), b"aaaa")
                after_first = opened.call_count
                self.assertEqual(read_bytes(str(self.target)), b"aaaa")
                self.assertGreater(opened.call_count, after_first)
            self.assertEqual(coordinator_io._pin_cache, {})

    def test_kill_switch_is_sticky_against_a_scrubbed_environment(self):
        original = coordinator_io._pin_cache_state
        try:
            with patch.dict(os.environ, {"SWARM_PIN_CACHE": "0"}):
                coordinator_io._pin_cache_state = None
                self.assertEqual(coordinator_io.pin_cache_budget(), 0)
            # A fixture that clears os.environ must not re-enable reuse mid-process.
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(coordinator_io.pin_cache_budget(), 0)
                self.assertEqual(read_bytes(str(self.target)), b"aaaa")
                self.assertEqual(coordinator_io._pin_cache, {})
        finally:
            coordinator_io._pin_cache_state = original

    def test_a_second_path_to_the_same_inode_is_never_served_from_the_cache(self):
        # Inode numbers are recycled and timestamps are quantized, so an entry is
        # bound to the path it was read from, never to the identity alone.
        alias = self.root / "alias.bin"
        os.link(self.target, alias)
        self.assertEqual(read_bytes(str(self.target)), b"aaaa")
        with patch.object(os, "open", wraps=_REAL_OPEN) as opened:
            before = opened.call_count
            self.assertEqual(read_bytes(str(alias)), b"aaaa")
            self.assertGreater(opened.call_count, before)

    def test_tiny_budget_retains_nothing_and_stays_correct(self):
        with patch.object(coordinator_io, "_pin_cache_state", 1):
            self.assertEqual(read_bytes(str(self.target)), b"aaaa")
            self.assertEqual(coordinator_io._pin_cache, {})
            self.assertEqual(read_bytes(str(self.target)), b"aaaa")

    def test_replacement_through_publish_and_replace_is_always_seen(self):
        self.assertEqual(read_bytes(str(self.target)), b"aaaa")
        replace_json(self.target, {"same": 1})
        self.assertEqual(read_bytes(str(self.target)), canonical({"same": 1}) + b"\n")
        publish_new(self.root / "other.bin", b"dddd")
        self.assertEqual(read_bytes(str(self.root / "other.bin")), b"dddd")

    def test_retained_entry_is_bounded_and_evicts_oldest(self):
        with patch.object(coordinator_io, "_pin_cache_state", 96):
            for index in range(6):
                (self.root / ("f%d" % index)).write_bytes(b"x" * 32)
                read_bytes(str(self.root / ("f%d" % index)))
            self.assertLessEqual(len(coordinator_io._pin_cache), 3)
            clear_pin_cache()
            self.assertEqual(coordinator_io._pin_cache, {})


if __name__ == "__main__":
    unittest.main()
