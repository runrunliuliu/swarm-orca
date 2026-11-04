from datetime import timedelta
import unittest

from coordinator_creation_time import creation_bounds, next_creation_second
from coordinator_io import timestamp


class CreationTimeTests(unittest.TestCase):
    def test_native_precision_is_an_interval_not_an_exact_instant(self):
        for value, width in (("2026-10-25T12:11:59Z", 1000000),
                             ("2026-10-25T12:11:59.250Z", 1000),
                             ("2026-10-25T20:11:59.250000+08:00", 1)):
            with self.subTest(value=value):
                start, end = creation_bounds(value)
                self.assertEqual(start, timestamp(value))
                self.assertEqual(end - start, timedelta(microseconds=width))

    def test_ceil_gate_without_backdating_or_changing_exact_seconds(self):
        self.assertEqual(next_creation_second("2026-10-25T23:59:59.250000Z"),
                         timestamp("2026-10-26T00:00:00Z"))
        self.assertEqual(next_creation_second("2026-10-25T12:00:00Z"),
                         timestamp("2026-10-25T12:00:00Z"))

    def test_unsupported_or_missing_precision_and_timezone_fail_closed(self):
        for value in ("2026-10-25T12:00Z", "2026-10-25 12:00:00", "2026-10-25",
                      "2026-10-25T12:00:00.1234567Z", "2026-10-25T12:00:00"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                creation_bounds(value)
