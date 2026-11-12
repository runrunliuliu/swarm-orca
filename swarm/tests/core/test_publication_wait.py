"""The publication wait may be shortened by an event, never defined by one.

Elsewhere in this suite the two strict waits polled with `time.sleep(0.25)` for a file another
process publishes. Same-client writes reach inotify in 1-2 ms on the NFSv4.1 mount this repo runs
on (measured: 40/40 files, no losses), but a publish from a *different* client may fire no event at
all. So the primitive is built the safe way round: the caller keeps its deadline and its lstat, and
an event can only cut the wait short. These assertions pin that, including the degraded path where
inotify cannot be opened at all.
"""

import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr
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

    def test_without_inotify_the_wait_keeps_the_pre_change_poll_period(self):
        # Why: "no inotify here" must not become a slower deployment. Nothing can shorten that
        # wait, so it spends the 250 ms the two strict waits spent before this change - not the
        # 1.5 s fallback that exists for a lost event where watches do work.
        self.assertEqual(publication_wait.POLL_SECONDS, 0.25)
        started = time.monotonic()
        self.assertFalse(publication_wait.idle(None, 5.0))
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.2)
        self.assertLess(elapsed, 0.9)

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

    def test_the_fallback_period_stays_the_documented_worst_case(self):
        # Why: the fallback period *is* the worst-case delivery latency, so it may not drift back
        # down to the 250 ms poll this replaces (that would delete the saving) nor up to a period
        # a startup window cannot absorb. The startup log prints it; this pins the range.
        self.assertGreaterEqual(publication_wait.FALLBACK_SECONDS, 1.0)
        self.assertLessEqual(publication_wait.FALLBACK_SECONDS, 2.0)

    def test_the_log_line_states_the_fallback_period_and_the_counters(self):
        # Why: the deployment machine has to read the fallback period and whether events arrive
        # from the startup log alone; a diagnostics line that omits either is not observable.
        watcher = publication_wait.watch(self.dir / "gate-ready.json")
        try:
            publication_wait.idle(watcher, 0.05)
            out = io.StringIO()
            with redirect_stderr(out):
                publication_wait.log("gate", watcher)
        finally:
            watcher.close()
        row = json.loads(out.getvalue().strip())
        self.assertEqual(row, {"event": "publication_wait", "kind": "gate", "inotify": True,
                               "events": 0, "timeouts": 1,
                               "fallback_seconds": publication_wait.FALLBACK_SECONDS})

    def test_the_log_line_never_claims_inotify_when_it_is_unavailable(self):
        # The period in the log is the one actually in force: the pre-change poll, not the fallback.
        out = io.StringIO()
        with redirect_stderr(out):
            publication_wait.log("gate", None)
        row = json.loads(out.getvalue().strip())
        self.assertEqual((row["inotify"], row["events"], row["timeouts"]), (False, 0, 0))
        self.assertEqual(row["fallback_seconds"], publication_wait.POLL_SECONDS)

if __name__ == "__main__":
    unittest.main()
