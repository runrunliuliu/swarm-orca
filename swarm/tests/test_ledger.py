import copy
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from supervisor.config import SafetyError
from swarm_ledger.__main__ import main
from swarm_ledger.codex import scan
from swarm_ledger.ledger import Ledger, elapsed, timestamp, token_counts
from swarm_ledger.native import Reader
from swarm_ledger.report import csv_text, export


START = "2026-10-13T00:00:00Z"
END = "2026-10-13T00:10:00Z"


def run(rid="run-1"):
    return {"id": rid, "created_at": START, "coordinator_handle": "term-1", "objective": "SECRET"}


def worker(did="dispatch-1", *, rid="run-1", ended="2026-10-13T00:05:00Z"):
    return {
        "dispatch": {"id": did, "runId": rid, "taskId": "task-1", "dispatchedAt": "2026-10-13 00:01:00",
                     "completedAt": ended, "status": "completed" if ended else "dispatched"},
        "worker": {"dispatchId": did, "state": "succeeded" if ended else "ready", "startOptions": {
            "launch": {"effective": {"agent": "codex", "model": "test-model", "effort": "high"}}}},
        "terminal": {"preview": "SECRET transcript", "handle": "historical-only"},
        "terminalResource": {"releaseCompletedAt": "2026-10-13 00:06:00"},
    }


def sample(session="session-1", *, since=START, until=END, n=100):
    return {"provider": "codex", "session_id": session, "since": since, "until": until,
            "tokens": {"input_tokens": n, "output_tokens": n // 2, "cache_read_tokens": 20,
                       "reasoning_tokens": 10}, "source": "provider-receipt-sha256", "complete": True}


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.ledger = Ledger(self.root / "state", clock=lambda: 1791850800)  # 2026-10-13 03:00Z
        self.ledger.sync("rt", run(), [worker(), worker("dispatch-2")])

    def tearDown(self):
        self.ledger.close()
        self.tmp.cleanup()

    def test_parallel_elapsed_and_unknown_not_zero(self):
        r = self.ledger.report("rt", "run-1")
        self.assertIsNone(r["summary"]["wall_seconds"])
        self.assertEqual(r["summary"]["known_agent_seconds"], 480)
        self.assertIsNone(r["summary"]["total_tokens"])
        self.assertEqual(r["summary"]["unknown_usage_count"], 3)
        self.ledger.finish("rt", "run-1", ended_at=END, outcome="succeeded", source="coordinator-checkpoint")
        self.assertEqual(self.ledger.report("rt", "run-1")["summary"]["wall_seconds"], 600)

    def test_coordinator_span_separate_from_run_and_preserved(self):
        self.ledger.coordinator("rt", "run-1", started_at=START, ended_at=END, source="checkpoint")
        self.ledger.sync("rt", run(), [worker(), worker("dispatch-2")])
        self.assertEqual(self.ledger.report("rt", "run-1")["summary"]["agent_seconds"], 1080)

    def test_usage_idempotent_and_final_all_actors(self):
        for aid in ("coordinator", "dispatch-1", "dispatch-2"):
            self.ledger.usage("rt", "run-1", aid, sample(aid), final=True)
            self.ledger.usage("rt", "run-1", aid, sample(aid), final=True)
        report = self.ledger.report("rt", "run-1")
        self.assertEqual(report["summary"]["total_tokens"], 450)
        self.assertEqual(report["summary"]["known_tokens"]["cache_read_tokens"], 60)
        self.ledger.sync("rt", run(), [worker(), worker("dispatch-2")])
        self.assertEqual(self.ledger.report("rt", "run-1")["summary"]["total_tokens"], 450)

    def test_incremental_snapshot_replaces_not_adds(self):
        self.ledger.usage("rt", "run-1", "dispatch-1", sample())
        self.ledger.usage("rt", "run-1", "dispatch-1", sample(n=200))
        self.assertEqual(self.ledger.report("rt", "run-1")["summary"]["known_tokens"]["total_tokens"], 300)

    def test_overlapping_cross_run_or_actor_refused(self):
        self.ledger.usage("rt", "run-1", "dispatch-1", sample())
        self.ledger.sync("rt", run("run-2"), [])
        for rid, aid in (("run-1", "dispatch-2"), ("run-2", "coordinator")):
            with self.assertRaisesRegex(SafetyError, "overlapping"):
                self.ledger.usage("rt", rid, aid, sample())
        self.ledger.usage("rt", "run-2", "coordinator", sample(since=END, until="2026-10-13T00:11:00Z"))

    def test_regression_final_conflict_and_bad_input_atomic(self):
        self.ledger.usage("rt", "run-1", "dispatch-1", sample())
        with self.assertRaisesRegex(SafetyError, "regressed"):
            self.ledger.usage("rt", "run-1", "dispatch-1", sample(n=50))
        self.ledger.usage("rt", "run-1", "dispatch-1", sample(), final=True)
        with self.assertRaisesRegex(SafetyError, "finalized"):
            self.ledger.usage("rt", "run-1", "dispatch-1", sample(n=200))
        self.assertEqual(self.ledger.report("rt", "run-1")["summary"]["known_tokens"]["total_tokens"], 150)

    def test_partial_cannot_be_final(self):
        s = sample()
        s["complete"] = False
        with self.assertRaisesRegex(SafetyError, "incomplete"):
            self.ledger.usage("rt", "run-1", "coordinator", s, final=True)
        self.assertEqual(self.ledger.report("rt", "run-1")["summary"]["unknown_usage_count"], 3)

    def test_empty_sample_not_zero(self):
        s = sample()
        s["tokens"] = {}
        self.ledger.usage("rt", "run-1", "coordinator", s)
        self.assertIsNone(self.ledger.report("rt", "run-1")["agents"][0]["tokens"]["total_tokens"])

    def test_mixed_unknown_samples_preserve_known_subtotal(self):
        self.ledger.usage("rt", "run-1", "dispatch-1", sample())
        unknown = sample("another-session")
        unknown["tokens"] = {}
        unknown["complete"] = False
        self.ledger.usage("rt", "run-1", "dispatch-1", unknown)
        report = self.ledger.report("rt", "run-1")
        actor = next(a for a in report["agents"] if a["agent_id"] == "dispatch-1")
        self.assertIsNone(actor["tokens"]["total_tokens"])
        self.assertEqual(actor["known_tokens"]["total_tokens"], 150)
        self.assertEqual(report["summary"]["known_tokens"]["total_tokens"], 150)

    def test_provider_mismatch_and_native_provider_change_refused(self):
        wrong = sample()
        wrong["provider"] = "trae"
        with self.assertRaisesRegex(SafetyError, "provider"):
            self.ledger.usage("rt", "run-1", "dispatch-1", wrong)
        self.ledger.usage("rt", "run-1", "dispatch-1", sample())
        w = worker()
        w["worker"]["startOptions"]["launch"]["effective"]["agent"] = "trae"
        with self.assertRaisesRegex(SafetyError, "provider"):
            self.ledger.sync("rt", run(), [w, worker("dispatch-2")])
        self.ledger.usage("rt", "run-1", "coordinator", sample("coordinator-session"))
        with self.assertRaisesRegex(SafetyError, "provider"):
            self.ledger.coordinator("rt", "run-1", started_at=START, ended_at=END,
                                    source="checkpoint", provider="trae")

    def test_coordinator_metadata_preserved_when_omitted(self):
        self.ledger.coordinator("rt", "run-1", started_at=START, ended_at=None,
                                source="start", provider="codex", model="test-model")
        self.ledger.coordinator("rt", "run-1", started_at=START, ended_at=END, source="end")
        self.assertEqual(self.ledger.report("rt", "run-1")["agents"][0]["provider"], "codex")

    def test_batch_rollback_on_later_invalid_binding(self):
        before = self.ledger.report("rt", "run-1")
        with self.assertRaisesRegex(SafetyError, "unknown Agent"):
            with self.ledger.transaction():
                self.ledger.usage("rt", "run-1", "dispatch-1", sample())
                self.ledger.usage("rt", "run-1", "missing-agent", sample("s2"))
        self.assertEqual(before, self.ledger.report("rt", "run-1"))

    def test_empty_window_and_mismatched_total_refused(self):
        with self.assertRaisesRegex(SafetyError, "nonempty"):
            self.ledger.usage("rt", "run-1", "dispatch-1", sample(since=END))
        s = sample()
        s["tokens"]["total_tokens"] = 9999
        with self.assertRaisesRegex(SafetyError, "total_tokens"):
            self.ledger.usage("rt", "run-1", "dispatch-1", s)

    def test_failed_attempt_included(self):
        w = worker("retry-1")
        w["dispatch"]["retryOfDispatchId"] = "dispatch-1"
        w["worker"]["state"] = "failed"
        self.ledger.sync("rt", run(), [worker(), worker("dispatch-2"), w])
        self.assertEqual(self.ledger.report("rt", "run-1")["summary"]["agent_count"], 4)

    def test_bad_native_inventory_does_not_overwrite(self):
        before = self.ledger.report("rt", "run-1")
        with self.assertRaisesRegex(SafetyError, "lost"):
            self.ledger.sync("rt", run(), [worker()])
        self.assertEqual(before, self.ledger.report("rt", "run-1"))

    def test_foreign_or_duplicate_dispatch_refused(self):
        for fleet in ([worker(), worker()], [worker(rid="foreign")]):
            with self.assertRaises(SafetyError):
                self.ledger.sync("rt", run(), fleet)

    def test_native_null_optional_metadata_stays_unknown(self):
        w = worker("unknown-meta")
        w["worker"]["startOptions"] = None
        w["terminalResource"] = None
        self.ledger.sync("rt", run(), [worker(), worker("dispatch-2"), w])
        actor = next(a for a in self.ledger.report("rt", "run-1")["agents"] if a["agent_id"] == "unknown-meta")
        self.assertIsNone(actor["provider"])
        self.assertIsNone(actor["released_at"])

    def test_active_coordinator_cannot_close_run(self):
        self.ledger.coordinator("rt", "run-1", started_at=START, ended_at=None, source="start")
        with self.assertRaisesRegex(SafetyError, "unfinished"):
            self.ledger.finish("rt", "run-1", ended_at=END, outcome="succeeded", source="end")

    def test_run_close_needs_real_end_not_release_or_last_worker(self):
        self.ledger.sync("rt", run("live"), [worker(rid="live", ended=None)])
        with self.assertRaisesRegex(SafetyError, "unfinished"):
            self.ledger.finish("rt", "live", ended_at=END, outcome="succeeded", source="checkpoint")

    def test_closed_run_cannot_gain_workers_or_change_finish(self):
        self.ledger.finish("rt", "run-1", ended_at=END, outcome="succeeded", source="checkpoint")
        with self.assertRaises(SafetyError):
            self.ledger.sync("rt", run(), [worker(), worker("dispatch-2"), worker("dispatch-3")])
        with self.assertRaises(SafetyError):
            self.ledger.finish("rt", "run-1", ended_at=END, outcome="failed", source="checkpoint")

    def test_private_export_and_reopen(self):
        result = export(self.ledger, self.root / "out")
        self.assertEqual(result["runs"], 1)
        contents = "".join(p.read_text() for p in (self.root / "out").rglob("*") if p.is_file())
        self.assertNotIn("SECRET", contents)
        self.assertIn("未知", contents)
        for p in (self.root / "out").rglob("*"):
            self.assertEqual(p.stat().st_mode & 0o077, 0)
        other = Ledger(self.root / "state")
        self.assertEqual(other.report("rt", "run-1"), self.ledger.report("rt", "run-1"))
        other.close()

    def test_cli_offline_report_and_export(self):
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(["--state", str(self.root / "state"), "report", "--runtime-id", "rt", "--run", "run-1"]), 0)
        self.assertEqual(json.loads(output.getvalue())["run_id"], "run-1")

    def test_timezones_and_token_validation(self):
        self.assertEqual(timestamp("2026-10-13 00:00:00", native=True), START)
        self.assertEqual(elapsed(START, "2026-10-13T08:10:00+08:00"), 600)
        for value in ({"input_tokens": True}, {"output_tokens": -1}, {"input_tokens": 1, "cache_read_tokens": 2}):
            with self.assertRaises(SafetyError):
                token_counts(value)
        with self.assertRaises(SafetyError):
            timestamp("2026-10-13 00:00:00")
        with self.assertRaises(SafetyError):
            elapsed(END, START)

    def test_csv_formula_and_markdown_escape(self):
        self.assertIn("'=cmd", csv_text([{"x": "=cmd"}], ["x"]))
        self.assertIn("'  @cmd", csv_text([{"x": "  @cmd"}], ["x"]))


def event(t, total, last=None):
    def raw(n):
        return {"input_tokens": n, "output_tokens": n // 2,
                "cached_input_tokens": n // 5, "reasoning_output_tokens": n // 10} if n is not None else None
    return {"timestamp": f"2026-10-13T00:{t:02}:00Z", "type": "event_msg", "payload": {
        "type": "token_count", "info": {"total_token_usage": raw(total), "last_token_usage": raw(last)}}}


class CodexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "rollout.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self, records, *, since=START, suffix="", session="s1"):
        records = [{"type": "session_meta", "payload": {"id": "s1", "cwd": "SECRET"}}, *records]
        self.path.write_text("".join(json.dumps(r) + "\n" for r in records) + suffix)
        return scan(self.path, session, since, END)

    def test_increment_dedup_not_sum_cumulative(self):
        s = self.scan([event(1, 100, 100), event(1, 100, 100), event(2, 100, 100), event(3, 150, 50)])
        self.assertEqual(s["tokens"]["input_tokens"], 150)
        self.assertEqual(s["tokens"]["output_tokens"], 75)
        self.assertTrue(s["complete"])
        self.assertNotIn("SECRET", json.dumps(s))

    def test_baseline_before_window_and_boundary(self):
        s = self.scan([event(1, 100), event(2, 150), event(10, 200), event(11, 250)], since="2026-10-13T00:01:00Z")
        self.assertEqual(s["tokens"]["input_tokens"], 100)
        self.assertTrue(s["complete"])

    def test_no_baseline_counter_only_unknown(self):
        s = self.scan([event(1, 100)])
        self.assertIsNone(s["tokens"]["input_tokens"])
        self.assertFalse(s["complete"])

    def test_compaction_reset_last_increment_and_stale_regression(self):
        s = self.scan([event(1, 1000, 100), event(2, 990, 10), event(3, 100, 20), event(4, 150, 50)])
        self.assertEqual(s["tokens"]["input_tokens"], 170)
        self.assertIn("ambiguous_counter_regression", s["warnings"])
        self.assertFalse(s["complete"])

    def test_counter_reset_without_increment_is_partial(self):
        s = self.scan([event(1, 1000, 100), event(2, 10), event(3, 20)])
        self.assertEqual(s["tokens"]["input_tokens"], 110)
        self.assertIn("counter_reset_without_increment", s["warnings"])

    def test_missing_optional_counts_stays_unknown(self):
        e = event(1, 100, 100)
        e["payload"]["info"]["last_token_usage"].pop("reasoning_output_tokens")
        self.assertIsNone(self.scan([e])["tokens"]["reasoning_tokens"])

    def test_invalid_partial_line_and_session_mismatch(self):
        s = self.scan([event(1, 100, 100)], suffix="{broken")
        self.assertFalse(s["complete"])
        self.assertIn("partial_final_line", s["warnings"])
        with self.assertRaisesRegex(SafetyError, "identity"):
            self.scan([], session="another")

    def test_null_info_ignored_and_no_events_unknown(self):
        s = self.scan([{"type": "event_msg", "payload": {"type": "token_count", "info": None}}])
        self.assertIsNone(s["tokens"]["input_tokens"])

    def test_out_of_order_marked_partial(self):
        s = self.scan([event(3, 100, 100), event(2, 200, 100)])
        self.assertIn("out_of_order_usage", s["warnings"])

    def test_concurrent_truncation_does_not_loop(self):
        class Truncated(io.BytesIO):
            def seek(self, offset, whence=0):
                result = super().seek(offset, whence)
                return result + 100 if whence == 2 else result
        content = json.dumps({"type": "session_meta", "payload": {"id": "s1"}}) + "\n"
        content += json.dumps(event(1, 100, 100)) + "\n"
        with patch("pathlib.Path.open", return_value=Truncated(content.encode())):
            s = scan(self.path, "s1", START, END)
        self.assertIn("source_truncated_during_scan", s["warnings"])
        self.assertEqual(s["tokens"]["input_tokens"], 100)


class NativeTests(unittest.TestCase):
    def reader(self, pages=None, *, wrong_runtime=False):
        calls = []
        pages = pages or [{"workers": [], "page": {"hasMore": False}}]

        def invoke(argv, **kwargs):
            calls.append(argv)
            if argv[1] == "status":
                data = {"runtime": {"state": "ready", "reachable": True, "runtimeId": "rt", "appVersion": "1.4.219"}}
            elif argv[2] == "run-show":
                data = {"run": run()}
            elif argv[2] == "worker-list":
                data = pages.pop(0)
            else:
                data = worker(argv[argv.index("--dispatch") + 1])
            return subprocess.CompletedProcess(argv, 0, json.dumps({"ok": True, "result": data,
                "_meta": {"runtimeId": "wrong" if wrong_runtime else "rt"}}), "SECRET stderr")
        return Reader("orca", "rt", "env1", runner=invoke, env={}), calls

    def test_pagination_explicit_target_readonly(self):
        reader, calls = self.reader([
            {"workers": [{"dispatchId": "a"}], "page": {"hasMore": True, "nextCursor": "cursor1"}},
            {"workers": [{"dispatchId": "b"}], "page": {"hasMore": False}},
        ])
        _, receipts = reader.collect("run-1")
        self.assertEqual(len(receipts), 2)
        self.assertTrue(all("--environment" in c for c in calls))
        self.assertTrue(any("--cursor" in c for c in calls))
        with self.assertRaisesRegex(SafetyError, "read-only"):
            reader.read("orchestration", "worker-start")

    def test_partial_fleet_and_runtime_mismatch_refused(self):
        for reader in (self.reader([{ "workers": [], "warnings": ["partial"], "page": {"hasMore": False}}])[0],
                       self.reader(wrong_runtime=True)[0]):
            with self.assertRaises(SafetyError):
                reader.collect("run-1")

    def test_environment_override_refused(self):
        with self.assertRaises(SafetyError):
            Reader("orca", "rt", "env1", env={"ORCA_ENVIRONMENT": "other"})

    def test_foreign_scope_refused_even_for_empty_inventory(self):
        reader, _ = self.reader([{"workers": [], "scope": {"run": "another-run"}, "page": {"hasMore": False}}])
        with self.assertRaisesRegex(SafetyError, "scope mismatch"):
            reader.collect("run-1")


if __name__ == "__main__":
    unittest.main()
