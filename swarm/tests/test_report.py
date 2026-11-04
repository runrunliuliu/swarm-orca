"""Human-readable token units must never change exact accounting or provenance."""

import copy
import csv
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest

from swarm_ledger.__main__ import main
from swarm_ledger.ledger import Ledger
from swarm_ledger.report import export, format_tokens, markdown
from test_ledger import run, sample, worker


class TokenFormatTests(unittest.TestCase):
    def test_decimal_units_and_zero(self):
        for value, expected in (
            (None, "未知"), (0, "0"), (1, "1"), (999, "999"),
            (1_000, "1K"), (1_001, "1K"), (1_024, "1.02K"),
            (1_500, "1.5K"), (313_124, "313.12K"),
            (1_000_000, "1M"), (3_383_597, "3.38M"),
            (1_000_000_000, "1B"), (1_000_000_000_000, "1000B"),
        ):
            with self.subTest(value=value):
                self.assertEqual(format_tokens(value), expected)

    def test_half_up_rounding_and_unit_promotion(self):
        for value, expected in (
            (1_004, "1K"), (1_005, "1.01K"), (1_015, "1.02K"),
            (999_994, "999.99K"), (999_995, "1M"), (999_999, "1M"),
            (1_004_999, "1M"), (1_005_000, "1.01M"),
            (999_994_999, "999.99M"), (999_995_000, "1B"),
            (999_999_999, "1B"), (1_005_000_000, "1.01B"),
        ):
            with self.subTest(value=value):
                self.assertEqual(format_tokens(value), expected)

    def test_large_integers_do_not_lose_precision(self):
        for value, expected in (
            (9_007_199_254_999_999, "9007199.25B"),
            (9_007_199_255_000_000, "9007199.26B"),
            (10**30 + 5_000_000, "1000000000000000000000.01B"),
        ):
            with self.subTest(value=value):
                self.assertEqual(format_tokens(value), expected)

    def test_noninteger_counts_rejected(self):
        for value in (True, False, 1.5, "1000", [], {}):
            with self.subTest(value=value), self.assertRaises(TypeError):
                format_tokens(value)

    def test_negative_counts_rejected(self):
        with self.assertRaises(ValueError):
            format_tokens(-1)


class ReportFormatTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.ledger = Ledger(self.root / "state", clock=lambda: 1791850800)
        self.addCleanup(self.ledger.close)
        self.ledger.sync("rt", run(), [worker()])
        self.tokens = {"input_tokens": 3_346_167, "output_tokens": 37_430,
                       "cache_read_tokens": 2_916_291, "cache_write_tokens": 0,
                       "reasoning_tokens": 7_007, "total_tokens": 3_383_597}

    def add_usage(self, *, final=False):
        usage = sample("coordinator")
        usage["tokens"] = dict(self.tokens)
        self.ledger.usage("rt", "run-1", "coordinator", usage, final=final)

    def test_markdown_formats_every_token_field_without_mutation(self):
        self.add_usage()
        data = self.ledger.report("rt", "run-1")
        data["agents"][0]["elapsed_seconds"] = 2000.0
        data["agents"][0]["turn_seconds"] = 2500.0
        before = copy.deepcopy(data)
        result = markdown(data)
        self.assertEqual(data, before)
        self.assertIn("Token 完整合计：未知；已知小计：3.38M", result)
        self.assertIn("| 3.35M | 37.43K | 2.92M | 0 | 7.01K | 3.38M | partial |", result)
        self.assertIn("| 2000.0 | 2500.0 |", result)
        self.assertIn("Token 展示采用十进制 K/M/B", result)
        self.assertIn("未知不是 0", result)

    def test_unknown_and_known_zero_remain_distinct(self):
        output = self.root / "out"
        export(self.ledger, output)
        target = next((output / "runs").iterdir())
        self.assertIn("Token 完整合计：未知；已知小计：0", (target / "ledger.md").read_text())
        self.assertIn("| 0 | 未知 | 2/0 |", (output / "index.md").read_text())

    def test_exports_and_cli_keep_exact_integers(self):
        self.add_usage(final=True)
        zero = sample("worker")
        zero["tokens"] = {key: 0 for key in self.tokens}
        self.ledger.usage("rt", "run-1", "dispatch-1", zero, final=True)
        before = self.ledger.report("rt", "run-1")
        output = self.root / "out"
        export(self.ledger, output)
        self.assertEqual(self.ledger.report("rt", "run-1"), before)
        target = next((output / "runs").iterdir())
        data = json.loads((target / "ledger.json").read_text())
        self.assertEqual(data, before)
        actor = next(row for row in data["agents"] if row["agent_id"] == "coordinator")
        self.assertEqual(actor["tokens"], self.tokens)
        summary = json.loads((output / "index.json").read_text())[0]
        self.assertEqual(summary["known_total_tokens"], 3_383_597)
        self.assertEqual(summary["total_tokens"], 3_383_597)
        rows = list(csv.DictReader(io.StringIO((target / "agents.csv").read_text())))
        actor = next(row for row in rows if row["agent_id"] == "coordinator")
        for key, value in self.tokens.items():
            self.assertEqual(actor[key], str(value))
        summary = next(csv.DictReader(io.StringIO((output / "runs.csv").read_text())))
        self.assertEqual(summary["known_total_tokens"], "3383597")
        self.assertEqual(summary["total_tokens"], "3383597")
        self.assertIn("| 3.38M | 3.38M | 0/0 |", (output / "index.md").read_text())
        self.assertIn("Token 完整合计：3.38M；已知小计：3.38M", (target / "ledger.md").read_text())
        # Time and lifecycle values are not token counts and must not be abbreviated.
        self.assertIn("已知 Agent 累计耗时：240.0 秒", (target / "ledger.md").read_text())
        with redirect_stdout(io.StringIO()) as result:
            self.assertEqual(main(["--state", str(self.root / "state"), "report",
                                   "--runtime-id", "rt", "--run", "run-1"]), 0)
        self.assertEqual(json.loads(result.getvalue()), before)


if __name__ == "__main__":
    unittest.main()
