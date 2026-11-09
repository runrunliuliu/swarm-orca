import copy
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from supervisor.config import SafetyError
from swarm_ledger.__main__ import main
from swarm_ledger.ledger import Ledger
from swarm_ledger.report import export
from swarm_ledger import trae
from core.test_ledger import run, worker

START = "2026-10-13T00:00:00Z"
END = "2026-10-13T00:10:00Z"
EPOCH = 1791849600


def binding():
    return {"runtime_id": "rt", "run_id": "run-1", "agent_id": "dispatch-1", "host": {"kind": "local", "hostId": "local"},
            "thread_id": "thread-1", "session_id": "tree-1", "source": "launch-receipt:sha256:verified"}


def raw(n=100):
    return {"inputTokens": n, "outputTokens": n // 2, "cachedInputTokens": n // 5,
            "cacheCreationInputTokens": n // 10, "reasoningOutputTokens": n // 10, "totalTokens": n + n // 2}


def turn(tid="turn-1", offset=100, status="completed"):
    return {"id": tid, "startedAt": EPOCH + offset, "completedAt": EPOCH + offset + 60,
            "durationMs": 60123, "status": status, "items": [{"text": "SECRET transcript"}], "error": "SECRET error"}


def snapshot(n=100, *, turns=None, at=END):
    response = {"thread": {"id": "thread-1", "sessionId": "tree-1", "createdAt": EPOCH,
                           "status": {"type": "idle"}, "cliVersion": "0.209.1", "cwd": "SECRET",
                           "turns": [turn()] if turns is None else turns},
                "tokenUsage": {"total": raw(n), "last": raw(9999)}}
    return trae.snapshot(response, binding(), at, at)


def verified(current=None, baseline=None, **kwargs):
    return trae.scan(current or snapshot(), baseline, dedicated=baseline is None,
                     semantics="cumulative-inclusive", semantics_source="verified-counter-contract", **kwargs)


class SnapshotTests(unittest.TestCase):
    def test_metadata_whitelist(self):
        value = snapshot()
        self.assertNotIn("SECRET", json.dumps(value))
        self.assertEqual(value["tokens"]["inputTokens"], 100)
        self.assertEqual(len(value["response_sha256"]), 64)

    def test_dedicated_thread_total_not_last_or_cache_double_count(self):
        s = verified()
        self.assertEqual(s["tokens"]["total_tokens"], 150)
        self.assertEqual(s["tokens"]["cache_read_tokens"], 20)
        self.assertEqual(s["tokens"]["cache_write_tokens"], 10)
        self.assertTrue(s["complete"])
        self.assertTrue(s["turn_timing_complete"])

    def test_unverified_counts_unknown_but_timings_retained(self):
        s = trae.scan(snapshot(), dedicated=True)
        self.assertIsNone(s["tokens"]["total_tokens"])
        self.assertIn("counter_semantics_unverified", s["warnings"])
        self.assertTrue(s["turn_timing_complete"])

    def test_counter_contract_needs_evidence(self):
        with self.assertRaises(SafetyError):
            trae.scan(snapshot(), dedicated=True, semantics="cumulative-inclusive")

    def test_shared_thread_subtracts_fixed_baseline(self):
        baseline = snapshot(100, turns=[], at="2026-10-13T00:01:00Z")
        s = verified(snapshot(150), baseline)
        self.assertEqual(s["tokens"]["total_tokens"], 75)
        self.assertEqual(s["since"], baseline["observed_at"])

    def test_baseline_or_dedicated_required(self):
        for kwargs in ({}, {"baseline": snapshot(0), "dedicated": True}):
            with self.assertRaises(SafetyError):
                trae.scan(snapshot(), **kwargs)

    def test_missing_usage_never_zero(self):
        value = snapshot()
        value["tokens"] = {}
        s = verified(value)
        self.assertIsNone(s["tokens"]["total_tokens"])
        self.assertTrue(s["turn_timing_complete"])

    def test_missing_baseline_never_charges_prior_history(self):
        b = snapshot(0, turns=[], at="2026-10-13T00:01:00Z")
        b["tokens"] = {}
        self.assertIsNone(verified(snapshot(), b)["tokens"]["total_tokens"])

    def test_explicit_zero_is_valid(self):
        self.assertEqual(verified(snapshot(0))["tokens"]["total_tokens"], 0)

    def test_optional_cache_creation_does_not_default_zero(self):
        value = snapshot()
        del value["tokens"]["cacheCreationInputTokens"]
        s = verified(value)
        self.assertIsNone(s["tokens"]["cache_write_tokens"])
        self.assertTrue(s["complete"])

    def test_reset_is_unknown_not_negative(self):
        b = snapshot(200, turns=[], at="2026-10-13T00:01:00Z")
        s = verified(snapshot(), b)
        self.assertIn("counter_regression_or_reset", s["warnings"])
        self.assertIsNone(s["tokens"]["total_tokens"])

    def test_inconsistent_totals_or_cache_or_reasoning_are_unknown(self):
        for key, value in (("totalTokens", 888), ("cachedInputTokens", 999), ("reasoningOutputTokens", 999)):
            s = snapshot()
            s["tokens"][key] = value
            self.assertIn("counter_semantics_mismatch", verified(s)["warnings"])

    def test_bad_absolute_counters_cannot_cancel_in_delta(self):
        b = snapshot(100, turns=[], at="2026-10-13T00:01:00Z")
        c = snapshot(200)
        b["tokens"]["totalTokens"] += 5
        c["tokens"]["totalTokens"] += 5
        self.assertIn("counter_semantics_mismatch", verified(c, b)["warnings"])

    def test_active_or_inprogress_cannot_settle(self):
        for field in ("status", "turn"):
            s = snapshot()
            if field == "status":
                s["thread_status"] = "active"
            else:
                s["turns"][0]["status"] = "inProgress"
            result = verified(s)
            self.assertIn("snapshot_not_quiescent", result["warnings"])
            self.assertFalse(result["turn_timing_complete"])

    def test_baseline_scope_mismatch_and_reversed_window(self):
        for field in ("runtime_id", "run_id", "agent_id", "thread_id", "session_id", "host"):
            b = snapshot(0, turns=[], at="2026-10-13T00:01:00Z")
            b["binding"][field] = {"kind": "ssh", "hostId": "wrong"} if field == "host" else "wrong"
            with self.assertRaises(SafetyError):
                verified(snapshot(), b)
        with self.assertRaises(SafetyError):
            verified(snapshot(), snapshot())

    def test_history_truncation_or_change_does_not_finalize(self):
        b = snapshot(100, at="2026-10-13T00:03:00Z")
        for turns in ([], [turn(status="failed")]):
            self.assertIn("turn_history_changed", verified(snapshot(200, turns=turns), b)["warnings"])

    def test_prior_turns_not_counted_again(self):
        b = snapshot(100, at="2026-10-13T00:03:00Z")
        s = verified(snapshot(200, turns=[turn(), turn("turn-2", 200)]), b)
        self.assertEqual([t["id"] for t in s["turns"]], ["turn-2"])

    def test_missing_timing_does_not_destroy_known_tokens(self):
        value = snapshot()
        value["turns"][0]["duration_ms"] = None
        s = verified(value)
        self.assertFalse(s["turn_timing_complete"])
        self.assertTrue(s["complete"])

    def test_duration_mismatch_and_boundary_turn_not_credited(self):
        value = snapshot()
        value["turns"][0]["duration_ms"] = 9999999
        self.assertIsNone(verified(value)["turns"][0]["duration_ms"])
        b = snapshot(0, turns=[], at="2026-10-13T00:02:00Z")
        s = verified(snapshot(), b)
        self.assertEqual(s["turns"], [])
        self.assertFalse(s["turn_timing_complete"])

    def test_thread_identity_not_shared_session_tree_is_accounting_key(self):
        s = verified()
        self.assertEqual(s["session_id"], "thread-1")
        self.assertEqual(s["trae_provenance"]["session_tree_id"], "tree-1")

    def test_malformed_snapshot_refused(self):
        for key, value in (("schema_version", True), ("schema_version", 1.0),
                           ("tokens", {"inputTokens": True}), ("response_sha256", "x"),
                           ("thread_status", "other"), ("observed_at", START)):
            s = snapshot()
            s[key] = value
            with self.assertRaises(SafetyError):
                verified(s)
        s = snapshot()
        s["turns"].append(copy.deepcopy(s["turns"][0]))
        with self.assertRaises(SafetyError):
            verified(s)


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.ledger = Ledger(self.root / "state")
        self.w = worker()
        self.w["worker"]["startOptions"]["launch"]["effective"]["agent"] = "trae"
        self.w["dispatch"]["hostScope"] = binding()["host"]
        self.ledger.sync("rt", run(), [self.w])
        self.path = self.root / "receipts" / "end.json"
        trae.write_snapshot(self.path, snapshot())

    def tearDown(self):
        self.ledger.close()
        self.tmp.cleanup()

    def cli(self, *args):
        with redirect_stdout(io.StringIO()) as output:
            main(["--state", str(self.root / "state"), *args])
        return json.loads(output.getvalue())

    def test_scan_cli_repeat_and_finalized_immutable(self):
        argv = ["scan-trae", "--runtime-id", "rt", "--run", "run-1", "--agent-id", "dispatch-1", "--file", str(self.path),
                "--dedicated-session", "--semantics", "cumulative-inclusive", "--semantics-source", "verified", "--final"]
        self.cli(*argv)
        data = self.cli(*argv)
        worker_row = data["agents"][1]
        self.assertEqual(data["summary"]["known_tokens"]["total_tokens"], 150)
        self.assertIsNone(data["summary"]["total_tokens"])
        self.assertEqual(worker_row["turn_seconds"], 60.123)
        self.assertEqual(worker_row["elapsed_seconds"], 240)
        changed = verified(snapshot(200))
        with self.assertRaisesRegex(SafetyError, "finalized"):
            self.ledger.usage("rt", "run-1", "dispatch-1", changed)

    def test_partial_cannot_finalize(self):
        with self.assertRaisesRegex(SafetyError, "incomplete"):
            self.ledger.usage("rt", "run-1", "dispatch-1", trae.scan(snapshot(), dedicated=True), final=True)

    def test_scope_checks_run_actor_host_provider(self):
        for field in ("run_id", "agent_id", "host"):
            b = binding()
            b[field] = {"kind": "ssh", "hostId": "wrong"} if field == "host" else "wrong"
            with self.assertRaises(SafetyError):
                trae.check_scope(self.ledger, "rt", "run-1", "dispatch-1", b)

    def test_missing_and_changed_turns_refused_atomically(self):
        s = verified()
        self.ledger.usage("rt", "run-1", "dispatch-1", s)
        for turns in ([], [{**s["turns"][0], "duration_ms": 60124}]):
            value = {**s, "turns": turns, "turn_timing_complete": False}
            with self.assertRaises(SafetyError):
                self.ledger.usage("rt", "run-1", "dispatch-1", value)
        self.assertEqual(self.ledger.report("rt", "run-1")["agents"][1]["turn_seconds"], 60.123)

    def test_same_thread_cannot_be_attributed_twice(self):
        s = verified()
        self.ledger.usage("rt", "run-1", "dispatch-1", s)
        with self.assertRaisesRegex(SafetyError, "overlapping"):
            self.ledger.usage("rt", "run-1", "coordinator", s)

    def test_export_no_transcripts_and_private_receipts(self):
        self.ledger.usage("rt", "run-1", "dispatch-1", verified())
        export(self.ledger, self.root / "out")
        text = "".join(p.read_text() for p in (self.root / "out").rglob("*") if p.is_file())
        self.assertNotIn("SECRET", text)
        self.assertIn("turn_seconds", text)
        self.assertIn("60.123", text)
        self.assertEqual(self.path.stat().st_mode & 0o077, 0)
        with self.assertRaises(SafetyError):
            trae.write_snapshot(self.path, snapshot(200))
        self.assertEqual(trae.load_snapshot(self.path)["tokens"]["inputTokens"], 100)

    def test_sync_bindings_roll_back_entire_batch_on_scope_error(self):
        bindings = self.root / "bindings.json"
        first = {"provider": "trae", "agent_id": "dispatch-1", "file": str(self.path), "dedicated_session": True,
                 "semantics": "cumulative-inclusive", "semantics_source": "verified"}
        bindings.write_text(json.dumps([first, {**first, "agent_id": "wrong"}]))
        before = self.ledger.report("rt", "run-1")
        with patch("swarm_ledger.__main__.Reader") as reader:
            reader.return_value.collect.return_value = (run(), [self.w])
            with self.assertRaises(SafetyError):
                self.cli("sync", "--runtime-id", "rt", "--run", "run-1", "--cli", "orca", "--bindings", str(bindings))
        self.assertEqual(before, self.ledger.report("rt", "run-1"))
        bindings.write_text(json.dumps([first]))
        with patch("swarm_ledger.__main__.Reader") as reader:
            reader.return_value.collect.return_value = (run(), [self.w])
            self.cli("sync", "--runtime-id", "rt", "--run", "run-1", "--cli", "orca", "--bindings", str(bindings))
        self.assertEqual(self.ledger.report("rt", "run-1")["summary"]["known_tokens"]["total_tokens"], 150)


class TransportTests(unittest.TestCase):
    def reader(self, **kwargs):
        with patch.object(Path, "stat", return_value=SimpleNamespace(st_mode=stat.S_IFSOCK, st_uid=os.getuid())):
            return trae.ProxyReader("/verified/traecli", "/verified/control.sock", **kwargs)

    def capture(self, mode="ok", *, timeout=2, version="traecli 0.209.1"):
        reader = self.reader(timeout=timeout)
        popen = subprocess.Popen
        fixture = str(Path(__file__).parents[1] / "fixtures" / "trae_proxy.py")
        commands = []
        def start(argv, **kwargs):
            commands.append(argv)
            return popen([sys.executable, "-u", fixture, mode], **kwargs)
        with patch("swarm_ledger.trae.subprocess.run", return_value=subprocess.CompletedProcess([], 0, version, "SECRET")), \
             patch("swarm_ledger.trae.subprocess.Popen", side_effect=start), \
             patch("swarm_ledger.trae.utc_now", return_value=END):
            value = reader.capture(binding())
        return value, commands

    def test_real_jsonl_handshake_read_and_proxy_only(self):
        value, commands = self.capture()
        self.assertEqual(commands, [["/verified/traecli", "app-server", "proxy", "--sock", "/verified/control.sock"]])
        self.assertNotIn("SECRET", json.dumps(value))
        self.assertIsNone(value["tokens"]["inputTokens"])

    def test_transport_errors_sanitized_and_no_approval(self):
        for mode in ("eof", "request", "error", "malformed", "wrong_id"):
            with self.subTest(mode=mode), self.assertRaises(SafetyError) as error:
                self.capture(mode)
            self.assertNotIn("SECRET", str(error.exception))

    def test_timeout_still_enforced(self):
        with self.assertRaisesRegex(SafetyError, "timeout"):
            self.capture("timeout", timeout=0.1)

    def test_response_larger_than_32_mib_is_accepted_and_redacted(self):
        value, _ = self.capture("large", timeout=15)
        self.assertNotIn("SECRET", json.dumps(value))
        self.assertLess(len(json.dumps(value)), 4096)
        self.assertIsNone(value["tokens"]["inputTokens"])

    def test_old_alias_cli_refused(self):
        with self.assertRaisesRegex(SafetyError, "version"):
            self.capture(version="Coco 0.120.10")

    def test_socket_must_exist_and_be_user_owned(self):
        with self.assertRaises(OSError):
            trae.ProxyReader("/verified/traecli", "/does-not-exist-for-ledger.sock")
        with patch.object(Path, "stat", return_value=SimpleNamespace(st_mode=stat.S_IFSOCK, st_uid=os.getuid() + 1)):
            with self.assertRaises(SafetyError):
                trae.ProxyReader("/verified/traecli", "/control.sock")


if __name__ == "__main__":
    unittest.main()
