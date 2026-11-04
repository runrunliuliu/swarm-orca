"""Real-shaped provider task events; history observation never refreshes authority."""

import copy
from datetime import timedelta
import json
import unittest

from coordinator_io import now, timestamp
from trae_tui import completed_log_turn
import test_trae_tui as tui


TURN = "23456789-1234-1234-1234-123456789012"


class CompletedTurnTests(unittest.TestCase):
    def setUp(self):
        self.f = tui.TuiTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.anchor = self.f.ref("anchor.json", self.f.observe())

    def append(self, *rows):
        with self.f.f.log.open("a") as out:
            for row in rows:
                out.write(json.dumps(row) + "\n")

    def events(self, age=0):
        start = (timestamp(now()) - timedelta(seconds=age)).isoformat()
        context = copy.deepcopy(self.f.f.context)
        context["timestamp"] = start
        context["payload"]["turn_id"] = TURN
        return [dict(type="event_msg", timestamp=start, payload=dict(type="task_started", turn_id=TURN)),
                context, dict(type="event_msg", timestamp=now(), payload=dict(type="task_complete", turn_id=TURN))]

    def observe(self):
        return self.f.observe(expected_thread=tui.legacy.SID, startup_anchor=self.anchor, completed_turn=True)

    def test_missing_complete_is_not_silence_based_completion(self):
        self.assertIsNone(self.observe())
        self.append(*self.events()[:2])
        self.assertIsNone(self.observe())

    def test_historical_completed_context_is_not_a_fresh_business_context(self):
        self.append(*self.events(age=901))
        result = self.observe()
        self.assertEqual(result["completed_turn"]["turn_id"], TURN)
        self.assertFalse(result["execution_authorized"])
        with self.assertRaises(tui.ContextFreshnessError):
            self.f.observe(expected_thread=tui.legacy.SID, startup_anchor=self.anchor)

    def test_new_start_before_context_and_partial_append_block_old_completion(self):
        self.append(*self.events())
        self.assertIsNotNone(self.observe())
        with self.f.f.log.open("a") as out:
            out.write('{"type":')
        self.assertIsNone(completed_log_turn(self.f.f.log))

    def test_new_start_invalidates_previous_completion(self):
        self.append(*self.events())
        self.append(dict(type="event_msg", timestamp=now(), payload=dict(type="task_started", turn_id=TURN)))
        self.assertIsNone(self.observe())

    def test_mismatched_completion_and_changed_anchor_fail_closed(self):
        rows = self.events()
        rows[-1]["payload"]["turn_id"] = "another"
        self.append(*rows)
        with self.assertRaisesRegex(ValueError, "completion_mismatch"):
            self.observe()

    def test_future_completion_is_not_evidence(self):
        rows = self.events()
        rows[-1]["timestamp"] = (timestamp(now()) + timedelta(seconds=5)).isoformat()
        self.append(*rows)
        with self.assertRaisesRegex(ValueError, "completion_time_invalid"):
            self.observe()


if __name__ == "__main__":
    unittest.main()
