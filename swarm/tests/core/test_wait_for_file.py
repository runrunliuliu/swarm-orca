"""`wait_for_file.py`: one bounded call, and the deadline - not an event - decides.

These run the wrapper against a real temporary directory, because the subject is a real inotify
watch and a real `stat`. The degraded path (no watcher at all) is exercised in-process with the
shared `PollingWatcher` fixture, so both paths are covered without a host that lacks inotify.

The cases worth pinning are the refusals: an unreachable parent must fail in milliseconds instead
of spending the caller's window, an unchanged file must not look changed, and a change must not be
reported before it happens.
"""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import publication_wait
import wait_for_file
from publication_wait_fixture import PollingWatcher

ROOT = Path(__file__).resolve().parents[2]
WRAPPER = ROOT / "wait_for_file.py"


class WrapperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def run_wrapper(self, *args, timeout=60):
        return subprocess.run([sys.executable, "-B", str(WRAPPER), *args],
                              capture_output=True, text=True, timeout=timeout)

    def publish_later(self, path: Path, content: str, delay: float):
        def publish():
            time.sleep(delay)
            path.write_text(content)

        thread = threading.Thread(target=publish, daemon=True)
        thread.start()
        return thread

    def rewrite_later(self, path: Path, content: str, delay: float):
        """A same-size rewrite, published asynchronously like a real writer would."""

        def publish():
            time.sleep(delay)
            path.write_text(content)

        thread = threading.Thread(target=publish, daemon=True)
        thread.start()
        return thread

    def test_a_file_that_is_already_there_returns_at_once(self):
        target = self.dir / "marker.json"
        target.write_text("{}")
        completed = self.run_wrapper("--path", str(target), "--timeout-ms", "30000")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "appeared")

    def test_a_publication_is_detected_before_the_deadline(self):
        # Why the 4 s window: the point is that the call returns when the file appears, not when
        # the budget runs out. A 1.5 s fallback period is still an order of magnitude inside it.
        target = self.dir / "marker.json"
        self.publish_later(target, "{}", 0.3)
        started = time.monotonic()
        completed = self.run_wrapper("--path", str(target), "--timeout-ms", "4000")
        elapsed = time.monotonic() - started
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertLess(elapsed, 3.0, "the wait did not wake on the publication")

    def test_no_publication_is_a_timeout_not_an_empty_success(self):
        target = self.dir / "never.json"
        completed = self.run_wrapper("--path", str(target), "--timeout-ms", "300")
        self.assertEqual(completed.returncode, 124, completed.stdout + completed.stderr)
        self.assertEqual(completed.stdout, "")
        self.assertIn("re-enter, do not act", completed.stderr)

    def test_an_unreachable_parent_fails_immediately_instead_of_polling_to_timeout(self):
        # Why: a deadline cannot make a directory appear. Reporting 124 here would invite the
        # caller to try again, which is the failure this tool exists to remove.
        target = self.dir / "missing" / "marker.json"
        started = time.monotonic()
        completed = self.run_wrapper("--path", str(target), "--timeout-ms", "30000")
        elapsed = time.monotonic() - started
        self.assertEqual(completed.returncode, 4, completed.stdout + completed.stderr)
        self.assertIn("unreachable", completed.stderr)
        self.assertLess(elapsed, 5.0)

    def test_a_change_wait_on_a_file_that_is_not_there_is_unreachable(self):
        target = self.dir / "absent.json"
        completed = self.run_wrapper("--path", str(target), "--mode", "change")
        self.assertEqual(completed.returncode, 4, completed.stdout + completed.stderr)

    def test_a_change_wait_does_not_return_before_the_change(self):
        target = self.dir / "published.json"
        target.write_text("initial")
        self.publish_later(target, "a longer body", 0.3)
        started = time.monotonic()
        completed = self.run_wrapper("--path", str(target), "--mode", "change",
                                     "--timeout-ms", "4000")
        elapsed = time.monotonic() - started
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "changed")
        self.assertGreater(elapsed, 0.25, "an unchanged file was reported as changed")

    def test_the_same_size_rewrite_moves_the_clock_and_is_detected(self):
        # `st_mtime_ns` is part of the signature for exactly this shape: a rewrite that keeps the
        # byte count still changes the file. (A rewrite inside one nanosecond with the same size
        # is the documented blind spot, not something this can be asked to see.)
        target = self.dir / "same-size.json"
        target.write_text("aaaa")
        self.rewrite_later(target, "bbbb", 0.3)
        started = time.monotonic()
        completed = self.run_wrapper("--path", str(target), "--mode", "change",
                                     "--timeout-ms", "4000")
        elapsed = time.monotonic() - started
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "changed")
        self.assertGreater(elapsed, 0.25, "the rewrite was reported before it happened")
        self.assertEqual(target.read_text(), "bbbb")

    def test_the_receipt_carries_counters_and_never_the_path_or_the_bytes(self):
        target = self.dir / "secret-marker.json"
        target.write_text("payload-that-must-not-be-echoed")
        completed = self.run_wrapper("--path", str(target), "--json", "--timeout-ms", "3000")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        row = json.loads(completed.stdout)
        self.assertEqual(row["outcome"], "appeared")
        for key in ("events", "timeouts", "fallback_seconds", "elapsed_ms"):
            self.assertIn(key, row)
        self.assertNotIn("path", row)
        self.assertNotIn(str(target), completed.stdout)
        self.assertNotIn("payload-that-must-not-be-echoed", completed.stdout)
        # The stderr diagnostic is the shared publication_wait line, counters only.
        self.assertIn("publication_wait", completed.stderr)
        self.assertNotIn(str(target), completed.stderr)

    def test_usage_errors_are_reported_as_usage(self):
        target = self.dir / "marker.json"
        for extra in (["--timeout-ms", "0"], ["--timeout-ms", "-1"],
                      ["--timeout-ms", str(wait_for_file.MAX_TIMEOUT_MS + 1)],
                      ["--mode", "whatever"]):
            with self.subTest(extra=extra):
                completed = self.run_wrapper("--path", str(target), *extra)
                self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)


class DegradedPathTests(unittest.TestCase):
    """No inotify: the wait must still be the old poll cadence, inside the same deadline."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_without_a_watcher_the_wait_keeps_the_previous_poll_cadence(self):
        # Why: `watch()` returns None when inotify cannot be opened. That host must behave exactly
        # like the loop this change replaces (250 ms probes), not like a slower fallback and not
        # like a hang.
        target = self.dir / "never.json"
        sleeps = []
        with patch.object(publication_wait, "watch", return_value=None), \
                patch.object(publication_wait, "log"), \
                patch.object(publication_wait.time, "sleep",
                             side_effect=lambda seconds: sleeps.append(seconds)):
            status, counters = wait_for_file.wait(str(target), "appear", 250)
        self.assertEqual(status, wait_for_file.TIMEOUT)
        self.assertTrue(sleeps, "the degraded path did not poll at all")
        self.assertLessEqual(max(sleeps), publication_wait.POLL_SECONDS)
        self.assertAlmostEqual(max(sleeps), publication_wait.POLL_SECONDS, places=2)
        self.assertFalse(counters["inotify"])
        self.assertEqual(counters["fallback_seconds"], publication_wait.POLL_SECONDS)

    def test_a_watcher_that_never_fires_does_not_hide_a_visible_file(self):
        target = self.dir / "marker.json"
        target.write_text("{}")
        watcher = PollingWatcher(lambda _: None)
        with patch.object(publication_wait, "watch", return_value=watcher), \
                patch.object(publication_wait, "log"):
            status, _ = wait_for_file.wait(str(target), "appear", 1000)
        self.assertEqual(status, wait_for_file.PRESENT)
        self.assertTrue(watcher.closed, "the watcher of a finished wait was not closed")


if __name__ == "__main__":
    unittest.main()
