"""Token-only fixtures for supported Trae JSONL producer versions."""

import copy
import csv
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from supervisor.config import SafetyError, digest
from swarm_ledger.__main__ import main, trae_jsonl_sample
from swarm_ledger.ledger import Ledger, seconds
from swarm_ledger.report import export
from swarm_ledger import raw_usage, trae_jsonl
from core.test_ledger import START, END, run, worker

T1 = "2026-10-13T00:02:00Z"
T2 = "2026-10-13T00:06:30Z"  # after worker_done AND release
T3 = "2026-10-13T00:07:00Z"


def meta(**changes):
    return {"type": "session_meta", "payload": {"id": "thread-1", "session_id": "tree-1",
            "model_provider": "trae", "cli_version": "0.209.1", "originator": "traex-tui", **changes}}


def counts(n=100):
    return dict(zip(raw_usage.FIELDS, (n, 20, 50, 0, 5, n + 20)))


def event(response="resp-1", at=T1, usage=None, total=None, **changes):
    return {"timestamp": at, "type": "token_usage_record", "payload": {
        "thread_id": "thread-1", "session_id": "tree-1", "turn_id": "turn-1", "response_id": response,
        "usage": counts() if usage is None else usage,
        "thread_token_usage": counts() if total is None else total, **changes}}


def complete(at=T3, **changes):
    return {"timestamp": at, "type": "event_msg", "payload": {"type": "task_complete", **changes}}


def timed_complete(at=T3, **changes):
    return complete(at, **{"turn_id": "turn-1", "started_at": int(seconds(at)) - 17,
                           "completed_at": int(seconds(at)), "duration_ms": 17055, **changes})


def mirror(usage=None, *, keyed=True):
    payload = {"type": "token_count", "info": {"last_token_usage": counts() if usage is None else usage,
                                              "total_token_usage": counts()}}
    if keyed:
        payload.update(turn_id="turn-1", response_id="resp-1")
    return {"timestamp": T1, "type": "event_msg", "payload": payload}


def encoded(rows):
    return b"".join(json.dumps(r).encode() + b"\n" for r in rows)


def native_worker():
    result = worker()
    result["worker"]["startOptions"]["launch"]["effective"]["agent"] = "trae"
    result["dispatch"]["hostScope"] = {"kind": "local", "hostId": "local"}
    return result


class TraeJsonlTests(unittest.TestCase):
    cli_version = "0.209.1"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.path = self.root / "log.jsonl"
        self.binding_path = self.root / "binding.json"
        header = encoded([meta(cli_version=self.cli_version)])
        self.bound = {"runtime_id": "rt", "run_id": "run-1", "agent_id": "dispatch-1",
                      "host": {"kind": "local", "hostId": "local"}, "thread_id": "thread-1",
                      "session_id": "tree-1", "terminal_handle": "historical-only",
                      "source": "verified-process-fd-evidence:sha256:test",
                      "verified_prefix": {"bytes": len(header), "sha256": hashlib.sha256(header).hexdigest()}}
        self.binding_path.write_text(json.dumps(self.bound))
        self.ledger = Ledger(self.root / "state", clock=lambda: 1791850800)
        self.addCleanup(self.ledger.close)
        self.ledger.sync("rt", run(), [native_worker()])
        self.write(event(), complete())

    def write(self, *rows):
        self.path.write_bytes(encoded([meta(cli_version=self.cli_version), *rows]))

    def scan(self, **kwargs):
        return trae_jsonl.scan(self.path, self.bound, kwargs.pop("since", START), kwargs.pop("until", END), **kwargs)

    def store(self, sample=None, **kwargs):
        return self.ledger.usage("rt", "run-1", "dispatch-1", sample or self.scan(), **kwargs)

    def options(self, **kwargs):
        return {"agent_id": "dispatch-1", "file": str(self.path), "binding": str(self.binding_path),
                "since": START, "until": END, **kwargs}

    def test_raw_counters_separate_from_normalized_and_never_final(self):
        result = self.scan()
        self.assertEqual(result["trae_provenance"]["thread_cli_version"], self.cli_version)
        self.assertEqual(result["raw_usage"]["contract"], raw_usage.trae_jsonl_contract(self.cli_version))
        self.assertEqual(result["raw_usage"]["counts"], counts())
        self.assertEqual(result["raw_usage"]["counts"]["cache_creation_input_tokens"], 0)
        report = self.store(result)
        actor = report["agents"][1]
        self.assertIsNone(actor["tokens"]["total_tokens"])
        self.assertIsNone(actor["tokens"]["cache_write_tokens"])
        self.assertEqual(report["summary"]["known_tokens"]["total_tokens"], 0)
        self.assertEqual(report["summary"]["raw_usage_groups"][0]["counts"]["total_tokens"], 120)
        with self.assertRaisesRegex(SafetyError, "incomplete"):
            self.store(result, final=True)

    def test_task_complete_timing_reaches_ledger_without_normalizing_tokens(self):
        self.write(event(), timed_complete())
        sample = self.scan()
        self.assertEqual(sample["turns"][0]["duration_ms"], 17055)
        self.assertFalse(sample["turn_timing_complete"])
        self.assertEqual(sample["warnings"], ["counter_semantics_unverified"])
        report = self.store(sample)
        actor = report["agents"][1]
        self.assertEqual(actor["turn_count"], 1)
        self.assertEqual(actor["known_turn_seconds"], 17.055)
        self.assertEqual(actor["turn_timing_status"], "partial")
        self.assertIsNone(actor["turn_seconds"])
        self.assertIsNone(actor["tokens"]["total_tokens"])
        self.assertNotEqual(actor["elapsed_seconds"], 17.055)
        self.assertEqual(self.store(sample)["agents"][1]["turn_count"], 1)

    def test_identical_completion_deduplicated(self):
        self.write(event(), timed_complete(), timed_complete())
        self.assertEqual(len(self.scan()["turns"]), 1)

    def test_conflicting_turn_timings_rejected(self):
        self.write(event(), timed_complete(), timed_complete(duration_ms=17056))
        with self.assertRaisesRegex(SafetyError, "conflicting Trae turn"):
            self.scan()

    def test_later_window_does_not_reattribute_reemitted_completion(self):
        old = timed_complete(at=T1)
        late = copy.deepcopy(old)
        late["timestamp"] = T3
        self.write(event(), old, late)
        self.assertEqual(self.scan(since=T2)["turns"], [])

    def test_cross_window_turn_omitted_not_prorated(self):
        self.write(event(), timed_complete(started_at=int(seconds(T1))))
        sample = self.scan(since=T2)
        self.assertEqual(sample["turns"], [])
        self.assertIn("turn_outside_window", sample["turn_timing_warnings"])

    def test_invalid_or_unidentified_turns_do_not_discard_token_records(self):
        invalid = ({"turn_id": None}, {"duration_ms": True}, {"duration_ms": -1}, {"duration_ms": 17.055},
                   {"started_at": True}, {"completed_at": int(seconds(T3)) + 1},
                   {"started_at": int(seconds(T3)) + 1}, {"started_at": -1})
        for fields in invalid:
            with self.subTest(fields=fields):
                self.write(event(), timed_complete(**fields))
                sample = self.scan()
                self.assertEqual(sample["turns"], [])
                self.assertEqual(sample["raw_usage"]["counts"]["total_tokens"], 120)
                self.assertIn("invalid_or_unidentified_turn_timing", sample["turn_timing_warnings"])

    def test_duration_mismatch_is_unknown_not_inferred(self):
        self.write(event(), timed_complete(duration_ms=90000))
        sample = self.scan()
        self.assertIsNone(sample["turns"][0]["duration_ms"])
        self.assertIn("turn_duration_mismatch", sample["turn_timing_warnings"])

    def test_missing_duration_or_timestamp_stays_unknown(self):
        for fields in ({"duration_ms": None}, {"started_at": None}, {"completed_at": None}):
            with self.subTest(fields=fields):
                self.write(event(), timed_complete(**fields))
                sample = self.scan()
                self.assertIn("turn_timing_incomplete", sample["turn_timing_warnings"])
                self.assertIsNone(sample["turns"][0]["ended_at" if "completed_at" in fields else next(iter(fields))])

    def test_zero_duration_is_a_known_measurement(self):
        self.write(event(), timed_complete(started_at=int(seconds(T3)), duration_ms=0))
        self.assertEqual(self.scan()["turns"][0]["duration_ms"], 0)

    def test_foreign_thread_or_session_turn_is_excluded(self):
        for fields in ({"thread_id": "child-thread"}, {"session_id": "other-tree"}):
            self.write(event(), timed_complete(**fields))
            self.assertEqual(self.scan()["turns"], [])

    def test_completion_after_window_not_exported(self):
        self.write(event(), timed_complete())
        self.assertEqual(self.scan(until=T2)["turns"], [])

    def test_timings_export_whitelists_payload(self):
        self.write(event(), timed_complete(last_agent_message="private completion message", reasoning="private text"))
        sample = self.scan()
        self.assertNotIn("private", json.dumps(sample))

    def test_duplicate_families_and_response_reemissions_not_added(self):
        self.write(event(), event(), mirror(), mirror(keyed=False), complete())
        result = self.scan()
        self.assertEqual(len(result["raw_usage"]["requests"]), 1)
        self.assertEqual(result["raw_usage"]["counts"]["total_tokens"], 120)
        self.assertEqual(result["warnings"], ["counter_semantics_unverified"])

    def test_conflicting_duplicate_refused(self):
        self.write(event(), event(usage=counts(200)), complete())
        with self.assertRaisesRegex(SafetyError, "conflicting"):
            self.scan()

    def test_request_identity_includes_turn(self):
        total = {k: v * 2 for k, v in counts().items()}
        self.write(event(), event(at=T2, turn_id="turn-2", total=total), complete())
        self.assertEqual(len(self.scan()["raw_usage"]["requests"]), 2)

    def test_missing_identity_does_not_invent_request_key(self):
        self.write(event(response_id=None), complete())
        result = self.scan()
        self.assertEqual(result["raw_usage"]["requests"], [])
        self.assertIsNone(result["raw_usage"]["counts"]["total_tokens"])
        self.assertIn("invalid_usage_record", result["warnings"])

    def test_missing_optional_field_is_unknown_not_zero(self):
        usage = counts()
        del usage["cache_creation_input_tokens"]
        self.write(event(usage=usage), complete())
        raw = self.scan()["raw_usage"]
        self.assertIsNone(raw["counts"]["cache_creation_input_tokens"])
        self.assertEqual(raw["known_counts"]["cache_creation_input_tokens"], 0)

    def test_missing_required_raw_counter_keeps_known_subtotal(self):
        usage = counts()
        del usage["total_tokens"]
        self.write(event(), event("resp-2", T2, usage=usage), complete())
        result = self.scan()
        self.assertIsNone(result["raw_usage"]["counts"]["total_tokens"])
        self.assertEqual(result["raw_usage"]["known_counts"]["total_tokens"], 120)
        self.assertIn("missing_raw_counters", result["warnings"])

    def test_no_inclusive_semantics_assumptions(self):
        usage = counts()
        usage.update(cached_input_tokens=1000, reasoning_output_tokens=999, total_tokens=7)
        self.write(event(usage=usage), complete())
        self.assertEqual(self.scan()["raw_usage"]["counts"], usage)

    def test_negative_bool_and_string_counters_invalid(self):
        for value in (-1, True, "100"):
            with self.subTest(value=value):
                self.write(event(usage={"input_tokens": value}), complete())
                self.assertIn("invalid_usage_record", self.scan()["warnings"])

    def test_exact_binding_dimensions_and_native_identity(self):
        for key, value in (("runtime_id", "other"), ("run_id", "other"), ("agent_id", "other"),
                           ("terminal_handle", "other"), ("host", {"kind": "local", "hostId": "other"})):
            with self.subTest(key=key):
                bad = {**self.bound, key: value}
                with self.assertRaises(SafetyError):
                    trae_jsonl.check_scope(self.ledger, "rt", "run-1", "dispatch-1", bad)
        for key in ("thread_id", "session_id"):
            with self.subTest(key=key), self.assertRaisesRegex(SafetyError, "identity"):
                trae_jsonl.scan(self.path, {**self.bound, key: "other"}, START, END)

    def test_unknown_native_host_refused(self):
        value = self.ledger.get("rt", "run-1")
        value["agents"]["dispatch-1"]["host"] = None
        self.ledger.save(value)
        with self.assertRaisesRegex(SafetyError, "native execution host"):
            self.store()

    def test_terminal_preserved_after_release_and_conflict_refused(self):
        receipt = native_worker()
        receipt["terminal"] = None
        self.ledger.sync("rt", run(), [receipt])
        self.store()
        receipt["terminal"] = {"handle": "new-handle"}
        with self.assertRaisesRegex(SafetyError, "terminal changed"):
            self.ledger.sync("rt", run(), [receipt])

    def test_native_terminal_resource_fallback(self):
        receipt = native_worker()
        receipt["terminal"] = None
        receipt["terminalResource"]["terminalHandle"] = "historical-only"
        self.ledger.sync("rt", run(), [receipt])
        self.store()
        receipt["terminal"] = {"handle": "wrong"}
        with self.assertRaisesRegex(SafetyError, "terminal identity conflict"):
            self.ledger.sync("rt", run(), [receipt])

    def test_child_threads_excluded_and_tree_mismatch_warned(self):
        self.write(event(), event("child", T2, thread_id="child-1"),
                   event("foreign", T2, session_id="foreign-tree"), complete())
        result = self.scan()
        self.assertEqual(len(result["raw_usage"]["requests"]), 1)
        self.assertIn("event_session_mismatch", result["warnings"])

    def test_prefix_digest_version_provider_and_header_checked(self):
        bad = copy.deepcopy(self.bound)
        bad["verified_prefix"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(SafetyError, "prefix"):
            trae_jsonl.scan(self.path, bad, START, END)
        for fields in ({"cli_version": "0.999"}, {"cli_version": "0.210.2"}, {"cli_version": None},
                       {"cli_version": []}, {"cli_version": {}}, {"cli_version": True},
                       {"model_provider": "codex"}, {"originator": "unknown"}):
            with self.subTest(fields=fields):
                data = encoded([meta(**fields), event()])
                self.path.write_bytes(data)
                bad["verified_prefix"] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                with self.assertRaises(SafetyError):
                    trae_jsonl.scan(self.path, bad, START, END)

    def test_empty_header_anchor_and_concatenated_logs_refused(self):
        self.write(event(), meta())
        with self.assertRaisesRegex(SafetyError, "multiple"):
            self.scan()
        bad = copy.deepcopy(self.bound)
        bad["verified_prefix"] = {"bytes": 1, "sha256": hashlib.sha256(b"{").hexdigest()}
        with self.assertRaisesRegex(SafetyError, "outside verified prefix"):
            trae_jsonl.scan(self.path, bad, START, END)

    def test_no_metadata_and_usage_before_metadata_refused(self):
        for rows in ([event()], [event(), meta()]):
            data = encoded(rows)
            self.path.write_bytes(data)
            bound = {**self.bound, "verified_prefix": {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}}
            with self.assertRaises(SafetyError):
                trae_jsonl.scan(self.path, bound, START, END)

    def test_shared_window_boundaries_and_duplicate_across_windows(self):
        self.write(event(), event(at=T2), event("resp-2", T2), complete())
        first = self.scan(until=T1)
        second = self.scan(since=T1)
        self.assertEqual(len(first["raw_usage"]["requests"]), 1)
        self.assertEqual(len(second["raw_usage"]["requests"]), 1)
        self.store(first)
        report = self.store(second)
        self.assertEqual(report["summary"]["raw_usage_groups"][0]["request_count"], 2)

    def test_worker_done_does_not_clip_tail_and_growth_replaces(self):
        first = trae_jsonl_sample(self.ledger, "rt", "run-1", self.options())
        self.store(first)
        with self.path.open("ab") as target:
            target.write(encoded([event("resp-2", "2026-10-13T00:08:00Z"), complete("2026-10-13T00:09:00Z")]))
        second = trae_jsonl_sample(self.ledger, "rt", "run-1", self.options())
        self.assertEqual(len(second["raw_usage"]["requests"]), 2)
        self.assertTrue(second["raw_usage"]["task_complete_observed"])
        report = self.store(second)
        self.store(second)
        self.assertEqual(len(report["agents"][1]["usage_sources"]), 1)
        self.assertEqual(report["summary"]["raw_usage_groups"][0]["counts"]["total_tokens"], 240)

    def test_growing_until_and_idempotent_cli(self):
        self.write(event(), event("resp-2", T2), complete())
        self.store(self.scan(until=T1))
        self.store(self.scan())
        args = ["--state", str(self.root / "state"), "scan-trae-jsonl", "--runtime-id", "rt", "--run", "run-1",
                "--agent-id", "dispatch-1", "--file", str(self.path), "--binding", str(self.binding_path),
                "--since", START, "--until", END]
        for _ in range(2):
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main(args), 0)
            self.assertEqual(json.loads(output.getvalue())["summary"]["raw_usage_groups"][0]["request_count"], 2)

    def test_prefix_rewrite_after_original_anchor_refused_on_rescan(self):
        self.store()
        self.write(event(usage=counts(999)), complete(), complete(END))
        with self.assertRaisesRegex(SafetyError, "prefix changed"):
            trae_jsonl_sample(self.ledger, "rt", "run-1", self.options())

    def test_missing_history_binding_change_and_capture_regression_refused(self):
        original = self.scan()
        self.store(original)
        bad = copy.deepcopy(original)
        bad["raw_usage"]["requests"] = []
        bad["raw_usage"].update(raw_usage.totals([]))
        with self.assertRaisesRegex(SafetyError, "request history"):
            self.store(bad)
        bad = copy.deepcopy(original)
        bad["raw_usage"]["binding"]["source"] = "changed-evidence"
        with self.assertRaisesRegex(SafetyError, "binding changed"):
            self.store(bad)
        bad = copy.deepcopy(original)
        bad["raw_usage"]["capture"]["bytes"] -= 1
        with self.assertRaisesRegex(SafetyError, "capture regressed"):
            self.store(bad)

    def test_duplicate_request_attribution_across_nonoverlapping_windows_refused(self):
        first = self.scan(until=T1)
        self.store(first)
        second = copy.deepcopy(first)
        second.update(since=T1, until=END)
        with self.assertRaisesRegex(SafetyError, "duplicate raw request"):
            self.store(second)

    def test_other_actor_or_run_cannot_reuse_bound_sample(self):
        self.ledger.sync("rt", run("run-2"), [])
        with self.assertRaisesRegex(SafetyError, "scope mismatch"):
            self.ledger.usage("rt", "run-2", "coordinator", self.scan())

    def test_raw_payload_cannot_smuggle_normalized_or_forged_totals(self):
        for mutate in (lambda s: s.update(tokens={"input_tokens": 100, "output_tokens": 20}),
                       lambda s: s.update(complete=True),
                       lambda s: s["raw_usage"]["counts"].update(total_tokens=999)):
            bad = self.scan()
            mutate(bad)
            with self.assertRaises(SafetyError):
                self.store(bad)

    def test_import_keeps_producer_contract_and_rejects_relabeling(self):
        original = self.scan()
        actor = self.store(original)["agents"][1]
        self.assertEqual(actor["raw_usage_groups"][0]["contract"], original["raw_usage"]["contract"])
        other_version = "0.210.1" if self.cli_version == "0.209.1" else "0.209.1"
        for key in ("contract", "provenance", "missing_provenance"):
            bad = copy.deepcopy(original)
            if key == "contract":
                bad["raw_usage"]["contract"] = raw_usage.trae_jsonl_contract(other_version)
            elif key == "provenance":
                bad["trae_provenance"]["thread_cli_version"] = other_version
            else:
                del bad["trae_provenance"]
                del bad["turns"]
            with self.subTest(key=key), self.assertRaises(SafetyError):
                self.store(bad)
        bad = copy.deepcopy(original)
        bad["raw_usage"]["contract"] = raw_usage.trae_jsonl_contract(other_version)
        bad["trae_provenance"]["thread_cli_version"] = other_version
        with self.assertRaisesRegex(SafetyError, "raw usage contract changed"):
            self.store(bad)
        groups = raw_usage.groups([original, bad])
        self.assertEqual(len(groups), 2)  # Different producer contracts are not merged.

    def test_observed_02101_token_shape_with_cache_creation_and_duplicates(self):
        # Token-only values from two 2026-10-16 records; synthetic identities/times.
        first = dict(zip(raw_usage.FIELDS, (27809, 143, 0, 27806, 14, 27952)))
        second = dict(zip(raw_usage.FIELDS, (31961, 110, 27806, 4152, 11, 32071)))
        cumulative = {k: first[k] + second[k] for k in raw_usage.FIELDS}
        row1 = event(usage=first, total=first, root_turn_id="turn-1", turn_token_usage=first)
        row2 = event("resp-2", T2, usage=second, total=cumulative,
                     root_turn_id="turn-1", turn_token_usage=cumulative)
        self.write(row1, row2, row2, mirror(first), complete())
        result = self.scan()
        self.assertEqual(result["raw_usage"]["counts"], cumulative)
        self.assertEqual(len(result["raw_usage"]["requests"]), 2)
        self.assertEqual(result["warnings"], ["counter_semantics_unverified"])
        self.assertEqual(self.store(result)["agents"][1]["raw_usage_groups"][0]["counts"], cumulative)

    def test_raw_import_without_turns_keeps_version_provenance_on_reimport(self):
        sample = self.scan()
        del sample["turns"]
        stored = self.store(sample)["agents"][1]["usage_sources"][0]
        self.assertEqual(stored["trae_provenance"]["thread_cli_version"], self.cli_version)
        self.assertEqual(self.store(stored)["agents"][1]["usage_sources"][0], stored)

    def test_malformed_partial_line_and_invalid_timestamp(self):
        self.write(event(), event("bad", "SECRET-invalid-time"))
        with self.path.open("ab") as target:
            target.write(b"SECRET-invalid-json\n{\"incomplete\":")
        result = self.scan()
        self.assertTrue({"invalid_usage_record", "malformed_record", "partial_final_line"} <= set(result["warnings"]))
        self.assertEqual(result["raw_usage"]["counts"]["total_tokens"], 120)
        self.assertNotIn("SECRET", json.dumps(result))

    def test_out_of_order_and_counter_reset_are_not_silently_finalized(self):
        self.write(event(at=T2), event("resp-2", T1, total=counts(1)), complete())
        result = self.scan()
        self.assertIn("out_of_order_usage", result["warnings"])
        self.assertIn("cumulative_counter_regression", result["warnings"])
        self.assertEqual(len(result["raw_usage"]["requests"]), 2)

    def test_cumulative_gap_and_keyed_mirror_mismatch_diagnostics(self):
        self.write(event(), event("resp-2", T2, total=counts(900)), mirror(counts(123)), complete())
        result = self.scan()
        self.assertIn("cumulative_delta_mismatch", result["warnings"])
        self.assertIn("mirror_usage_mismatch", result["warnings"])
        self.assertEqual(result["raw_usage"]["counts"]["total_tokens"], 240)
        self.write(mirror(), complete())
        self.assertIn("mirror_without_request_record", self.scan()["warnings"])

    def test_corrupt_cumulative_diagnostic_does_not_drop_valid_request(self):
        self.write(event(total={"input_tokens": -1}), complete())
        result = self.scan()
        self.assertIn("invalid_cumulative_counter", result["warnings"])
        self.assertEqual(result["raw_usage"]["counts"]["total_tokens"], 120)

    def test_initial_cumulative_gap_reported(self):
        self.write(event(total=counts(999)), complete())
        self.assertIn("initial_cumulative_mismatch", self.scan()["warnings"])

    def test_completion_before_tail_is_not_completion_after_usage(self):
        self.write(event(), complete(T1), event("resp-2", T2))
        result = self.scan()
        self.assertFalse(result["raw_usage"]["task_complete_observed"])
        self.assertIn("no_task_complete_after_usage", result["warnings"])

    def test_concurrent_change_flag_is_not_quiescence(self):
        original = trae_jsonl.read_prefix
        def changed(*args, **kwargs):
            content, capture = original(*args, **kwargs)
            capture["stable"] = False
            return content, capture
        with patch.object(trae_jsonl, "read_prefix", side_effect=changed):
            result = self.scan()
        self.assertIn("source_changed_during_scan", result["warnings"])
        self.assertFalse(result["complete"])

    def test_log_larger_than_128_mib_preserves_usage(self):
        row = encoded([{"type": "response_item", "payload": {"text": "x" * (1024 * 1024)}}])
        with self.path.open("ab") as target:
            for _ in range(129):
                target.write(row)
        result = self.scan()
        self.assertEqual(result["raw_usage"]["counts"], counts())
        self.assertEqual(result["trae_provenance"]["thread_cli_version"], self.cli_version)

    def test_symlinks_fifo_and_empty_windows_refused(self):
        link = self.root / "link"
        link.symlink_to(self.path)
        with self.assertRaises(OSError):
            trae_jsonl.scan(link, self.bound, START, END)
        fifo = self.root / "fifo"
        os.mkfifo(fifo)
        with self.assertRaisesRegex(SafetyError, "regular file"):
            trae_jsonl.scan(fifo, self.bound, START, END)
        with self.assertRaisesRegex(SafetyError, "nonempty"):
            self.scan(since=END)

    def test_sync_reads_fresh_jsonl_and_rolls_back_whole_batch(self):
        bindings = self.root / "bindings.json"
        options = {**self.options(), "provider": "trae", "format": "jsonl"}
        bindings.write_text(json.dumps([options]))
        args = ["--state", str(self.root / "state"), "sync", "--runtime-id", "rt", "--run", "run-1",
                "--cli", "unused", "--bindings", str(bindings)]
        with patch("swarm_ledger.__main__.Reader") as reader:
            reader.return_value.collect.return_value = run(), [native_worker()]
            with redirect_stdout(io.StringIO()):
                main(args)
            with self.path.open("ab") as target:
                target.write(encoded([event("resp-2", "2026-10-13T00:08:00Z"), complete("2026-10-13T00:09:00Z")]))
            with redirect_stdout(io.StringIO()) as output:
                main(args)
            self.assertEqual(json.loads(output.getvalue())["summary"]["raw_usage_groups"][0]["request_count"], 2)
            before = self.ledger.get("rt", "run-1")
            bindings.write_text(json.dumps([options, {**options, "agent_id": "wrong"}]))
            with self.assertRaises(SafetyError):
                main(args)
            self.assertEqual(before, self.ledger.get("rt", "run-1"))

    def test_jsonl_scan_does_not_invoke_subprocess_or_model(self):
        with patch("subprocess.Popen", side_effect=AssertionError("no subprocess allowed")):
            sample = trae_jsonl_sample(self.ledger, "rt", "run-1", self.options())
            self.store(sample)

    def test_raw_sample_cannot_lose_provenance_or_change_scope_on_usage_import(self):
        sample = self.scan()
        self.store(sample)
        bad = copy.deepcopy(sample)
        del bad["raw_usage"]
        with self.assertRaisesRegex(SafetyError, "binding changed or removed"):
            self.store(bad)
        bad = copy.deepcopy(sample)
        bad["raw_usage"]["binding"]["terminal_handle"] = "foreign"
        with self.assertRaisesRegex(SafetyError, "terminal identity"):
            self.store(bad)

    def test_truncated_log_after_checkpoint_refused(self):
        self.store()
        self.path.write_bytes(encoded([meta(), event()]))
        with self.assertRaisesRegex(SafetyError, "prefix changed or truncated"):
            trae_jsonl_sample(self.ledger, "rt", "run-1", self.options())

    def test_raw_token_display_keeps_exact_counts_and_semantics(self):
        usage = dict(zip(raw_usage.FIELDS, (308284, 4840, 276992, 0, 2616, 313124)))
        self.write(event(usage=usage, total=usage), complete())
        self.store()
        before = self.ledger.report("rt", "run-1")
        output = self.root / "exports"
        export(self.ledger, output)
        target = output / "runs" / digest(["rt", "run-1"])
        report = (target / "ledger.md").read_text()
        self.assertIn("| 1 | 308.28K | 4.84K | 276.99K | 0 | 2.62K | 313.12K |", report)
        self.assertIn("Token 完整合计：未知；已知小计：0", report)
        self.assertIn("原始计数（口径未核验）", report)
        self.assertIn("不计入上表标准化 token", report)
        self.assertEqual(self.ledger.report("rt", "run-1"), before)
        self.assertEqual(json.loads((target / "ledger.json").read_text()), before)
        raw = next(csv.DictReader(io.StringIO((target / "raw-usage.csv").read_text())))
        for key, value in usage.items():
            self.assertEqual(raw["raw_" + key], str(value))
            self.assertEqual(raw["known_raw_" + key], str(value))
        self.assertEqual(raw["counter_semantics"], "unverified")
        self.assertIn("counter_semantics_unverified", raw["warnings"])
        actors = list(csv.DictReader(io.StringIO((target / "agents.csv").read_text())))
        actor = next(row for row in actors if row["agent_id"] == "dispatch-1")
        self.assertEqual(actor["total_tokens"], "")
        self.assertEqual(actor["known_total_tokens"], "0")

    def test_raw_export_private_separate_and_whitelisted(self):
        sample = self.scan()
        sample["raw_usage"]["SECRET"] = "SECRET transcript"
        sample["raw_usage"]["requests"][0]["prompt"] = "SECRET"
        self.store(sample)
        output = self.root / "exports"
        export(self.ledger, output)
        target = output / "runs" / digest(["rt", "run-1"])
        for path in output.rglob("*"):
            if path.is_file():
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertNotIn("SECRET", path.read_text())
        raw_csv = (target / "raw-usage.csv").read_text()
        self.assertIn("raw_total_tokens", raw_csv)
        self.assertIn("counter_semantics_unverified", raw_csv)
        self.assertIn("原始计数（口径未核验）", (target / "ledger.md").read_text())
        self.assertNotIn("raw_total_tokens", (target / "agents.csv").read_text())


class TraeJsonl02101Tests(TraeJsonlTests):
    """Run the same deduplication, safety, CLI and export regressions on 0.210.1."""
    cli_version = "0.210.1"


class TraeJsonl02111Tests(TraeJsonlTests):
    """Replay all safety regressions on the actual persistent-TUI producer."""
    cli_version = "0.211.1"

    def test_observed_02111_empty_cumulative_shape(self):
        # 2026-10-26 live TUI token-only record; synthetic identities/times.
        observed = dict(zip(raw_usage.FIELDS, (31033, 697, 7680, 0, 508, 31730)))
        row = event(usage=observed, total={}, root_turn_id="turn-1", turn_token_usage={})
        self.write(row, row, mirror(observed), event("child", thread_id="child-1"), complete())
        sample = self.scan()
        self.assertEqual(len(sample["raw_usage"]["requests"]), 1)
        self.assertEqual(sample["raw_usage"]["counts"], observed)
        self.assertEqual(sample["warnings"], ["counter_semantics_unverified"])
        self.assertEqual(sample["raw_usage"]["contract"], "trae-jsonl-0.211.1-token_usage_record")
        self.assertEqual(self.store(sample)["agents"][1]["raw_usage_groups"][0]["counts"], observed)


class TraeJsonl02121Tests(TraeJsonlTests):
    cli_version = "0.212.1"

    def test_observed_02121_counters_and_completion(self):
        # 2026-10-29 live TUI, token-only projection; synthetic identities/times.
        first = dict(zip(raw_usage.FIELDS, (30946, 1053, 7680, 0, 774, 31999)))
        second = dict(zip(raw_usage.FIELDS, (37419, 1646, 24064, 0, 1112, 39065)))
        total = {key: first[key] + second[key] for key in first}
        row = event(usage=first, total=first, root_turn_id="turn-1", turn_token_usage=first)
        self.write(row, row, mirror(first),
                   event("resp-2", usage=second, total=total, root_turn_id="turn-1", turn_token_usage=total),
                   timed_complete(at="2026-10-13T00:09:00Z",
                                  started_at=int(seconds("2026-10-13T00:09:00Z")) - 433, duration_ms=433502,
                                  time_to_first_token_ms=8302))
        sample = self.scan()
        self.assertEqual(len(sample["raw_usage"]["requests"]), 2)
        self.assertEqual(sample["raw_usage"]["counts"], total)
        self.assertEqual(sample["warnings"], ["counter_semantics_unverified"])
        self.assertEqual(sample["turns"][0]["duration_ms"], 433502)
        self.assertEqual(sample["tokens"], {})
        self.assertEqual(sample["raw_usage"]["contract"],
                         "trae-jsonl-" + self.cli_version + "-token_usage_record")


class TraeJsonl02131Tests(TraeJsonl02121Tests):
    """0.213.1 keeps the 0.212.1 token-only TUI JSONL shape."""
    cli_version = "0.213.1"


class TraeJsonl02141Tests(TraeJsonl02121Tests):
    """0.214.1 keeps the same token-only TUI JSONL shape.

    Checked 2026-11-09 against a live 0.214.1 transcript: `token_usage_record.usage`
    still uses the same counter names, `turn_context` still carries
    `model_backend_variant="max"`, and `session_meta` still has
    `originator=traex-tui`, `source=cli`, `cli_version=0.214.1`.
    """
    cli_version = "0.214.1"


if __name__ == "__main__":
    unittest.main()
