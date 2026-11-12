"""The publication wait may be shortened by an event, never defined by one.

Elsewhere in this suite the two strict waits polled with `time.sleep(0.25)` for a file another
process publishes. Same-client writes reach inotify in 1-2 ms on the NFSv4.1 mount this repo runs
on (measured: 40/40 files, no losses), but a publish from a *different* client may fire no event at
all. So the primitive is built the safe way round: the caller keeps its deadline and its lstat, and
an event can only cut the wait short. These assertions pin that, including the degraded path where
inotify cannot be opened at all.
"""

import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import publication_wait


class PublicationWaitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_an_event_returns_before_the_fallback_period(self):
        watcher = publication_wait.watch(self.dir / "gate-ready.json")
        self.assertIsNotNone(watcher)
        try:
            def publish():
                time.sleep(0.05)
                (self.dir / "gate-ready.json").write_text("{}")
            threading.Thread(target=publish).start()
            started = time.monotonic()
            hit = publication_wait.idle(watcher, 5.0)
            elapsed = time.monotonic() - started
            self.assertTrue(hit)
            self.assertLess(elapsed, 1.0, "an event should return long before the 5 s fallback")
        finally:
            watcher.close()

    def test_a_quiet_directory_returns_at_the_fallback_period(self):
        # Why: the wait must always return. A wait that blocks until an event would turn an
        # undelivered event into a hang, which is the failure this design exists to avoid.
        watcher = publication_wait.watch(self.dir / "gate-ready.json")
        try:
            started = time.monotonic()
            self.assertFalse(publication_wait.idle(watcher, 0.2))
            self.assertGreaterEqual(time.monotonic() - started, 0.15)
            self.assertEqual(watcher.timeouts, 1)
        finally:
            watcher.close()

    def test_without_inotify_the_wait_is_plain_sleep(self):
        # Why: a deployment where inotify cannot be opened (or where events never arrive) must
        # behave exactly like the polling loop it replaces.
        with patch.object(publication_wait, "Watcher", side_effect=OSError(13, "denied")):
            self.assertIsNone(publication_wait.watch(self.dir / "gate-ready.json"))
        started = time.monotonic()
        self.assertFalse(publication_wait.idle(None, 0.1))
        self.assertGreaterEqual(time.monotonic() - started, 0.09)

    def test_the_watcher_reports_counters_a_deployment_can_read(self):
        # Why: "is inotify working here?" must be answerable from logs. events=0 with timeouts>0
        # after a successful wait means the fallback period is the real delivery latency.
        watcher = publication_wait.watch(self.dir / "gate-ready.json")
        try:
            publication_wait.idle(watcher, 0.05)
            self.assertEqual((watcher.events, watcher.timeouts), (0, 1))
            (self.dir / "gate-ready.json").write_text("{}")
            publication_wait.idle(watcher, 1.0)
            self.assertGreater(watcher.events, 0)
        finally:
            watcher.close()

if __name__ == "__main__":
    unittest.main()
