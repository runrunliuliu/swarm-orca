import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys
import unittest
from unittest import mock

from coordinator_launch import BASE, build_plan, main
from coordinator_prepare import build_preparation, directory_snapshot, verify_files
from native_preflight import PreflightError, _evidence_check, run_preflight, validate_contract
import core.test_native_preflight as native_tests


class CoordinatorPrepareTests(unittest.TestCase):
    def setUp(self):
        self.fixture = native_tests.NativePreflightTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.contract = copy.deepcopy(self.fixture.contract)
        self.archive = self.fixture.archive
        for name in ("evidence", "receipts", "workers", "ledger"):
            (self.archive / name).mkdir()
        self.contract["evidence"] = {
            "session": str(self.archive / "evidence" / "session.json"),
            "file_tool": str(self.archive / "evidence" / "file-tool.json"),
        }
        self.model = self.fixture.root / "model.json"
        self.runtime = self.fixture.root / "runtime.json"
        selection = {"mode": "explicit", "agent": "codex", "model": "gpt-test",
                     "effort": "high", "max_mode": None}
        self.model.write_text(json.dumps({"schema_version": 1, "scope": "swarm_coordinator_only",
                                          "selection": selection}))
        self.runtime.write_text((BASE / "coordinator-runtime.json").read_text())
        self.args = {"cwd": self.fixture.cwd, "archive_dir": self.archive,
                     "model_config": self.model, "runtime_config": self.runtime,
                     "now": native_tests.NOW}
        self.runner = native_tests.FakeRunner(self.contract)

    def prepare(self, **kwargs):
        return build_preparation(self.contract, runner=self.runner, **self.args, **kwargs)

    def use_v2(self):
        self.contract.update(schema_version=2, adapter="codex-local",
            freshness={"session_max_age_seconds": 300, "file_tool_max_age_seconds": None},
            preparation={"attempt": 1, "max_attempts": 3},
            probe_roots=[str(self.archive), *[str(self.archive / p)
                         for p in ("evidence", "receipts", "workers", "ledger")]])
        self.contract["limits"].pop("evidence_max_age_seconds")
        self.contract["config_files"] += [str(self.model), str(self.runtime)]

    def next_attempt(self, seconds=3600):
        self.contract["preparation"]["attempt"] += 1
        attempt = self.contract["preparation"]["attempt"]
        self.contract["evidence"] = {kind: str(self.archive / "evidence" / f"{kind}-a{attempt}.json")
                                     for kind in ("session", "file_tool")}
        self.args["now"] += timedelta(seconds=seconds)
        hooks = json.loads(self.fixture.hooks.read_text())
        entry = hooks["entries"]["tab-1:leaf-1"]
        entry["evidenceObservedAt"] = self.args["now"].timestamp() * 1000 - 1000
        entry["receivedAt"] = self.args["now"].timestamp() * 1000
        self.fixture.hooks.write_text(json.dumps(hooks))

    def execute(self, bundle, mode="success"):
        # Real subprocess readback, fake apply_patch adapter; never Orca/model calls.
        harness = BASE / "tests" / "fixtures" / "coordinator-prepare-tools.cjs"
        result = subprocess.run(["node", str(harness), mode], input=json.dumps(bundle),
                                capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_generator_is_read_only_and_binds_fresh_native_session(self):
        before = sorted(str(p) for p in self.fixture.root.rglob("*"))
        bundle = self.prepare()
        self.assertEqual(before, sorted(str(p) for p in self.fixture.root.rglob("*")))
        plan = bundle["plan"]
        self.assertEqual(len(plan["directories"]), 5)
        self.assertEqual(plan["session"]["session_id"], self.contract["session"]["id"])
        self.assertEqual(len(self.runner.calls), 4)
        self.assertNotIn("SECRET", json.dumps(bundle))
        self.assertNotIn("worker-start", json.dumps(bundle))

    def test_batch_writes_real_receipts_accepted_by_unchanged_preflight(self):
        bundle = self.prepare()
        result = self.execute(bundle)
        self.assertTrue(result["receipt"]["ok"], result)
        self.assertEqual(result["receipt"]["decision"], "run_native_preflight")
        self.assertLess(len(json.dumps(result["receipt"])), 2500)
        probe = json.loads(Path(self.contract["evidence"]["file_tool"]).read_text())
        self.assertEqual(probe["batch_count"], 1)
        self.assertEqual(len(probe["roots"]), 5)
        self.assertTrue(run_preflight(self.contract, runner=self.runner, now=native_tests.NOW)["ok"])
        for path, digest in result["receipt"]["sha256"].items():
            self.assertEqual(hashlib.sha256(Path(path).read_bytes()).hexdigest(), digest)
        with self.assertRaisesRegex(PreflightError, "output_exists"):
            self.prepare()

    def test_empty_host_apply_patch_receipt_requires_successful_readback(self):
        result = self.execute(self.prepare(), "empty-receipt")
        self.assertTrue(result["receipt"]["ok"], result)

    def test_permission_denial_stops_without_read_or_rename_or_receipt(self):
        result = self.execute(self.prepare(), "denied")
        self.assertFalse(result["receipt"]["ok"])
        self.assertEqual(result["calls"], ["read", "patch"])
        self.assertFalse(Path(self.contract["evidence"]["file_tool"]).exists())

    def test_empty_receipt_without_write_never_becomes_success(self):
        result = self.execute(self.prepare(), "no-write")
        self.assertFalse(result["receipt"]["ok"])
        self.assertEqual(result["calls"], ["read", "patch", "read"])

    def test_changed_bytes_and_rename_failure_stop(self):
        for mode in ("corrupt-read", "rename-denied"):
            with self.subTest(mode=mode):
                # Each case gets an isolated fixture; no retry on the partial artifacts.
                test = CoordinatorPrepareTests()
                test.setUp()
                try:
                    result = test.execute(test.prepare(), mode)
                    self.assertFalse(result["receipt"]["ok"])
                    self.assertFalse(Path(test.contract["evidence"]["file_tool"]).exists())
                finally:
                    test.doCleanups()

    def test_expired_template_does_not_invoke_any_tool(self):
        result = self.execute(self.prepare(), "expired")
        self.assertEqual(result["receipt"]["code"], "preparation_session_expired")
        self.assertEqual(result["calls"], [])

    def test_chunked_exec_output_is_accumulated(self):
        result = self.execute(self.prepare(), "chunked")
        self.assertTrue(result["receipt"]["ok"], result)
        self.assertIn("wait", result["calls"])

    def test_stale_native_session_stops_before_tools(self):
        hooks = json.loads(self.fixture.hooks.read_text())
        hooks["entries"]["tab-1:leaf-1"]["providerSession"]["id"] = "old-session"
        self.fixture.hooks.write_text(json.dumps(hooks))
        with self.assertRaisesRegex(PreflightError, "current_session_identity_changed"):
            self.prepare()

    def test_native_rejection_stops_further_queries(self):
        self.runner.fail[("status",)] = {"code": "runtime_access_denied"}
        with self.assertRaises(PreflightError):
            self.prepare()
        self.assertEqual(len(self.runner.calls), 1)

    def test_output_collision_symlink_and_outside_scope_are_rejected(self):
        output = Path(self.contract["evidence"]["file_tool"])
        output.symlink_to(self.fixture.policy)
        with self.assertRaisesRegex(PreflightError, "path_changed"):
            self.prepare()
        output.unlink()
        self.contract["evidence"]["file_tool"] = str(self.fixture.root / "outside.json")
        with self.assertRaisesRegex(PreflightError, "outside_scope"):
            self.prepare()
        self.assertEqual(self.runner.calls, [])

    def test_scope_model_and_missing_directory_rejected(self):
        self.contract["session"]["effort"] = "low"
        with self.assertRaisesRegex(PreflightError, "settings_changed"):
            self.prepare()
        self.contract["session"]["effort"] = "high"
        (self.archive / "workers").rmdir()
        with self.assertRaises(PreflightError):
            self.prepare()

    def test_extra_roots_deduplicated_and_aliases_canonicalized(self):
        extra = self.fixture.root / "space's $(nope) `literal`"
        extra.mkdir()
        alias = self.fixture.root / "alias"
        alias.symlink_to(extra, target_is_directory=True)
        self.args["write_dirs"] = [extra, alias, self.archive]
        bundle = self.prepare()
        self.assertEqual(len(bundle["plan"]["directories"]), 6)
        result = self.execute(bundle)
        self.assertTrue(result["receipt"]["ok"], result)

    def test_directory_identity_change_is_rejected(self):
        plan = self.prepare()["plan"]
        directory = self.archive / "ledger"
        directory.rename(self.archive / "old-ledger")
        directory.mkdir()
        with self.assertRaisesRegex(PreflightError, "directory_changed"):
            verify_files({"directories": plan["directories"], "files": {}, "absent": []})

    def test_large_nfs_identifiers_survive_javascript_json_roundtrip(self):
        large = 2 ** 60 + 17
        with mock.patch("coordinator_prepare._canonical_directory", return_value=(
            self.archive, {"path": str(self.archive), "device": large, "inode": large + 1},
        )):
            _, snapshot = directory_snapshot(str(self.archive))
            result = subprocess.run(["node", "-e",
                "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1])))",
                json.dumps(snapshot)], capture_output=True, text=True, check=True)
            actual = json.loads(result.stdout)
            self.assertEqual(actual["device"], str(large))
            verify_files({"directories": [actual], "files": {}, "absent": []})

    def test_launch_plan_includes_ready_invocation_and_routes_subcommand(self):
        plan = build_plan(codex=sys.executable, cwd=self.fixture.cwd,
                          archive_dir=self.archive, model_config=self.model, runtime_config=self.runtime)
        command = shlex.split(plan["preparation"]["command"])
        self.assertIn("prepare-tools", command)
        self.assertEqual(command[command.index("--archive-dir") + 1], str(self.archive))
        self.assertIn("new Function", plan["preparation"]["functions_exec"])
        self.assertIn(plan["preparation"]["functions_exec"], plan["prompt_fragment"])
        with mock.patch("coordinator_prepare.cli_main", return_value=9) as prepare:
            self.assertEqual(main(["prepare-tools", "--contract", "/some/contract"]), 9)
        prepare.assert_called_once_with(["--contract", "/some/contract"])

    def test_v2_refresh_preserves_old_evidence_and_probe_completion_time(self):
        self.use_v2()
        first = self.execute(self.prepare())["receipt"]
        self.assertTrue(first["ok"], first)
        old_paths = first["evidence"]
        old_bytes = {p: Path(p).read_bytes() for p in old_paths.values()}
        old_probe = json.loads(old_bytes[old_paths["file_tool"]])
        self.next_attempt()
        result = self.execute(self.prepare(reuse_file_tool=old_paths["file_tool"]))
        self.assertTrue(result["receipt"]["ok"], result)
        # Only receipts are written: no second probe write/rename batch.
        self.assertEqual(result["calls"].count("patch"), 1)
        for p, data in old_bytes.items():
            self.assertEqual(Path(p).read_bytes(), data)
        receipt = json.loads(Path(self.contract["evidence"]["file_tool"]).read_text())
        self.assertEqual(receipt["completed_at"], old_probe["completed_at"])
        self.assertEqual(receipt["probe"], old_probe["probe"])
        self.assertNotEqual(receipt["revalidated_at"], receipt["completed_at"])
        self.assertNotEqual(result["receipt"]["evidence"]["operations"], old_paths["operations"])
        checked = run_preflight(self.contract, runner=self.runner, now=self.args["now"])
        self.assertTrue(checked["ok"], checked)
        self.assertTrue(checked["freshness"]["file_tool_revalidated"])
        with self.assertRaisesRegex(PreflightError, "output_exists"):
            self.prepare(reuse_file_tool=old_paths["file_tool"])

    def test_v2_new_probe_attempt_has_distinct_names_without_deleting_first(self):
        self.use_v2()
        first = self.prepare()
        self.assertTrue(self.execute(first)["receipt"]["ok"])
        self.next_attempt()
        second = self.prepare()
        self.assertTrue(set(first["plan"]["renamed_files"]).isdisjoint(second["plan"]["renamed_files"]))
        self.assertTrue(self.execute(second)["receipt"]["ok"])
        for name in first["plan"]["renamed_files"]:
            self.assertTrue(Path(name).exists())

    def test_v2_age_over_900_is_configurable_but_v1_is_unchanged(self):
        old = copy.deepcopy(self.contract)
        old["limits"]["evidence_max_age_seconds"] = 1800
        with self.assertRaisesRegex(PreflightError, "invalid_evidence_age"):
            validate_contract(old)
        self.use_v2()
        self.contract["freshness"]["session_max_age_seconds"] = 3600
        self.assertTrue(self.execute(self.prepare())["receipt"]["ok"])
        checked = run_preflight(self.contract, runner=self.runner,
                                now=native_tests.NOW + timedelta(seconds=1800))
        self.assertTrue(checked["ok"], checked)

    def test_v2_long_lived_probe_never_makes_stale_session_live(self):
        self.use_v2()
        self.assertTrue(self.execute(self.prepare())["receipt"]["ok"])
        checked = run_preflight(self.contract, runner=self.runner,
                                now=native_tests.NOW + timedelta(seconds=3600))
        self.assertFalse(checked["ok"])
        self.assertTrue(any(e["code"] in ("stale_session_mapping", "stale_session_evidence")
                            for e in checked["errors"]))

    def test_v2_expiry_during_preflight_blocks_dispatch(self):
        self.use_v2()
        self.assertTrue(self.execute(self.prepare())["receipt"]["ok"])
        ticks = iter([0, 301])
        checked = run_preflight(self.contract, runner=self.runner, now=native_tests.NOW,
                                monotonic=lambda: next(ticks))
        self.assertFalse(checked["ok"])
        self.assertIn("evidence_expired_during_preflight", [e["code"] for e in checked["errors"]])

    def test_v2_optional_probe_ttl_and_future_timestamp_are_enforced(self):
        self.use_v2()
        self.assertTrue(self.execute(self.prepare())["receipt"]["ok"])
        path = self.contract["evidence"]["file_tool"]
        self.contract["freshness"]["file_tool_max_age_seconds"] = 60
        with self.assertRaisesRegex(PreflightError, "stale_file_tool_evidence"):
            _evidence_check("file_tool", path, self.contract, native_tests.NOW + timedelta(seconds=61))
        self.contract["freshness"]["file_tool_max_age_seconds"] = None
        receipt = json.loads(Path(path).read_text())
        receipt["completed_at"] = (native_tests.NOW + timedelta(seconds=30)).isoformat()
        Path(path).write_text(json.dumps(receipt))
        with self.assertRaisesRegex(PreflightError, "future_file_tool_evidence"):
            _evidence_check("file_tool", path, self.contract, native_tests.NOW)

    def test_v2_reuse_rejects_changed_inputs_without_falling_back(self):
        for change in ("policy", "config", "probe", "directory", "identity", "proof", "roots"):
            with self.subTest(change=change):
                case = CoordinatorPrepareTests()
                case.setUp()
                try:
                    case.use_v2()
                    self.assertTrue(case.execute(case.prepare())["receipt"]["ok"])
                    path = case.contract["evidence"]["file_tool"]
                    receipt = json.loads(Path(path).read_text())
                    case.next_attempt()
                    if change == "policy":
                        case.fixture.policy.write_text("changed policy")
                    elif change == "config":
                        case.model.write_text(case.model.read_text() + "\n")
                    elif change == "probe":
                        Path(next(iter(receipt["probe"]["files"]))).write_text("changed probe")
                    elif change == "directory":
                        (case.archive / "ledger").chmod(0o500)
                    elif change == "identity":
                        receipt["session_id"] = "another-session"
                        Path(path).write_text(json.dumps(receipt))
                    elif change == "proof":
                        receipt.pop("probe")
                        Path(path).write_text(json.dumps(receipt))
                    else:
                        case.contract["probe_roots"] = [str(case.fixture.root)]
                    with self.assertRaises(PreflightError):
                        case.prepare(reuse_file_tool=path)
                    self.assertFalse(Path(case.contract["evidence"]["file_tool"]).exists())
                finally:
                    (case.archive / "ledger").chmod(0o700)
                    case.doCleanups()

    def test_v2_changed_config_after_generation_stops_before_any_write(self):
        self.use_v2()
        bundle = self.prepare()
        self.fixture.policy.write_text("policy changed after planning")
        result = self.execute(bundle)
        self.assertFalse(result["receipt"]["ok"])
        self.assertEqual(result["calls"], ["read"])

    def test_v2_attempt_bounds_and_unsupported_adapter(self):
        self.use_v2()
        original = copy.deepcopy(self.contract)
        for attempt, limit in ((0, 3), (4, 3), (1, 33), (True, 3)):
            self.contract["preparation"] = {"attempt": attempt, "max_attempts": limit}
            with self.assertRaisesRegex(PreflightError, "preparation_attempt_limit"):
                self.prepare()
        self.contract = original
        self.contract["adapter"] = "trae-local"
        self.contract["terminal"]["agent"] = "trae"
        with self.assertRaisesRegex(PreflightError, "unsupported_session_adapter"):
            self.prepare()

    def test_v2_reuse_cannot_skip_attempt_or_raise_limit(self):
        self.use_v2()
        self.assertTrue(self.execute(self.prepare())["receipt"]["ok"])
        path = self.contract["evidence"]["file_tool"]
        self.next_attempt()
        for prep in ({"attempt": 3, "max_attempts": 3}, {"attempt": 2, "max_attempts": 4}):
            self.contract["preparation"] = prep
            with self.assertRaisesRegex(PreflightError, "preparation_reuse_attempt_changed"):
                self.prepare(reuse_file_tool=path)

    def test_v2_unbound_model_config_is_rejected(self):
        self.use_v2()
        self.contract["config_files"].remove(str(self.model))
        with self.assertRaisesRegex(PreflightError, "preparation_config_not_bound"):
            self.prepare()

    def test_v2_same_sandbox_type_with_changed_policy_invalidates_probe(self):
        self.use_v2()
        self.assertTrue(self.execute(self.prepare())["receipt"]["ok"])
        path = self.contract["evidence"]["file_tool"]
        records = [json.loads(line) for line in self.fixture.log.read_text().splitlines()]
        records[-1]["payload"]["sandbox_policy"]["network_access"] = False
        self.fixture.log.write_text("\n".join(json.dumps(r) for r in records) + "\n")
        checked = run_preflight(self.contract, runner=self.runner, now=native_tests.NOW)
        self.assertFalse(checked["ok"])
        self.assertIn("file_tool_session_context_changed", [e["code"] for e in checked["errors"]])
        self.next_attempt()
        with self.assertRaisesRegex(PreflightError, "file_tool_session_context_changed"):
            self.prepare(reuse_file_tool=path)

    def test_v2_refresh_permission_failure_does_not_fall_back_to_new_probe(self):
        self.use_v2()
        self.assertTrue(self.execute(self.prepare())["receipt"]["ok"])
        path = self.contract["evidence"]["file_tool"]
        self.next_attempt()
        result = self.execute(self.prepare(reuse_file_tool=path), "denied")
        self.assertFalse(result["receipt"]["ok"])
        self.assertEqual(result["calls"].count("patch"), 1)
        self.assertEqual(result["calls"][-1], "patch")
        self.assertTrue(Path(path).exists())
        self.assertFalse(Path(self.contract["evidence"]["file_tool"]).exists())

    def test_v2_third_refresh_uses_original_probe_and_fixed_budget(self):
        self.use_v2()
        self.assertTrue(self.execute(self.prepare())["receipt"]["ok"])
        first = json.loads(Path(self.contract["evidence"]["file_tool"]).read_text())
        for attempt in (2, 3):
            path = self.contract["evidence"]["file_tool"]
            self.next_attempt()
            result = self.execute(self.prepare(reuse_file_tool=path))
            self.assertTrue(result["receipt"]["ok"], result)
            receipt = json.loads(Path(self.contract["evidence"]["file_tool"]).read_text())
            self.assertEqual(receipt["preparation"]["attempt"], attempt)
            self.assertEqual(receipt["completed_at"], first["completed_at"])
        path = self.contract["evidence"]["file_tool"]
        self.next_attempt()
        with self.assertRaisesRegex(PreflightError, "preparation_attempt_limit"):
            self.prepare(reuse_file_tool=path)

    def test_v2_modified_source_receipt_after_generation_blocks_refresh(self):
        self.use_v2()
        self.assertTrue(self.execute(self.prepare())["receipt"]["ok"])
        path = self.contract["evidence"]["file_tool"]
        self.next_attempt()
        bundle = self.prepare(reuse_file_tool=path)
        Path(path).write_text(Path(path).read_text() + "\n")
        result = self.execute(bundle)
        self.assertFalse(result["receipt"]["ok"])
        self.assertNotIn("patch", result["calls"])


if __name__ == "__main__":
    unittest.main()
