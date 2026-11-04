"""Contract transport regression: local executable stubs, no Orca or Agent I/O."""

import copy
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from coordinator_io import file_ref
import coordinator_driver as driver
import operator_monitor as monitor
import operator_continuity_route as route
import progress_watch as watch
import startup_cli as transport
import test_coordinator_driver as driver_tests
import test_coordinator_tui_scheduler as scheduler_tests


class ContractTransportTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name).resolve()
        for mock in (patch.dict(os.environ, {}, clear=True), patch.object(watch, "CLI", None)):
            mock.start()
            self.addCleanup(mock.stop)
        self.contract = self.stub("first", "rt")

    def stub(self, name, runtime):
        target = self.root / name
        target.write_text(f"#!{sys.executable}\nimport json, sys\nprint(json.dumps(" + repr({
            "ok": True, "_meta": {"runtimeId": runtime}, "result": {"selected": name}}) + "))\n")
        target.chmod(0o700)
        return dict(cli=file_ref(target), runtime=runtime)

    def test_inventory_and_monitor_special_routes_without_environment(self):
        for call, args in ((watch.query, ["status"]), (monitor.native, ["status"]),
                           (monitor.native, ["terminal", "show", "--terminal", "term_x"]),
                           (monitor.native, ["orchestration", "send", "--to", "run:test"])):
            with self.subTest(args=args):
                self.assertEqual(transport.bind(call, self.contract)(args, "rt"), {"selected": "first"})
                self.assertNotIn(transport.CLI_ENV, os.environ)

    def test_empty_or_conflicting_environment_never_spawns(self):
        call = transport.bind(monitor.native, self.contract)
        for value in ("", "/other/runtime/cli"):
            with patch.dict(os.environ, {transport.CLI_ENV: value}), patch.object(monitor.subprocess, "run") as spawn:
                with self.assertRaisesRegex(watch.StopObservation, "startup_cli_environment_conflict"):
                    call(["terminal", "show"], "rt")
                spawn.assert_not_called()

    def test_matching_environment_is_only_an_assertion(self):
        with patch.dict(os.environ, {transport.CLI_ENV: self.contract["cli"]["path"]}):
            self.assertEqual(transport.bind(watch.query, self.contract)(["status"], "rt"), {"selected": "first"})

    def test_cli_is_rechecked_on_every_call(self):
        call = transport.bind(watch.query, self.contract)
        call(["status"], "rt")
        target = Path(self.contract["cli"]["path"])
        target.write_text(target.read_text() + "# changed\n")
        with patch.object(watch.subprocess, "Popen") as spawn:
            with self.assertRaises(watch.StopObservation):
                call(["status"], "rt")
            spawn.assert_not_called()

    def test_non_executable_or_missing_cli_never_falls_back(self):
        target = Path(self.contract["cli"]["path"])
        target.chmod(0o600)
        with self.assertRaisesRegex(watch.StopObservation, "startup_cli_not_executable"):
            transport.bind(watch.query, self.contract)(["status"], "rt")
        target.unlink()
        with self.assertRaises(watch.StopObservation):
            transport.bind(watch.query, self.contract)(["status"], "rt")

    def test_runtime_and_response_identity_both_checked(self):
        call = transport.bind(watch.query, self.contract)
        with self.assertRaisesRegex(watch.StopObservation, "startup_cli_runtime_mismatch"):
            call(["status"], "other")
        wrong = dict(self.contract, runtime="other")
        with self.assertRaises(watch.StopObservation):
            transport.bind(watch.query, wrong)(["status"], "other")

    def test_scopes_reset_on_success_and_exception_and_do_not_leak(self):
        second = self.stub("second", "rt2")
        for contract in (self.contract, second, self.contract):
            self.assertEqual(transport.bind(watch.query, contract)(["status"], contract["runtime"]),
                             {"selected": Path(contract["cli"]["path"]).name})
        with transport.scope(self.contract):
            with self.assertRaisesRegex(ValueError, "startup_cli_binding_conflict"):
                transport.bind(watch.query, second)(["status"], "rt2")
        with self.assertRaisesRegex(watch.StopObservation, "orca_server_cli_required"):
            watch.query(["status"], "rt")

    def test_scoped_call_preserves_allowlist(self):
        with self.assertRaisesRegex(watch.ObservationError, "query_not_allowlisted"):
            transport.bind(monitor.native, self.contract)(["orchestration", "dispatch"], "rt")

    def test_explicit_continuity_routing_can_map_historical_runtime(self):
        # Simulate the already-verified route scope only; this is not a transition proof.
        successor = self.stub("successor", "target")
        historical = dict(successor, runtime="source")
        with patch.object(route, "runtime", side_effect=lambda r: "target" if r == "source" else r):
            call = transport.bind(route.routed(monitor.native), historical)
            self.assertEqual(call(["status"], "source"), {"selected": "successor"})

    def test_explicit_native_transport_cannot_escape_active_contract(self):
        from trae_coordinator import native
        with transport.scope(self.contract):
            self.assertEqual(native(self.contract["cli"]["path"], "rt", ["status"]), {"selected": "first"})
            with self.assertRaisesRegex(ValueError, "startup_cli_path_mismatch"):
                native("/other/cli", "rt", ["status"])


class DriverContractTests(unittest.TestCase):
    def setUp(self):
        self.f = driver_tests.DriverTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        f = self.f
        cli = f.root / "cli"
        cli.write_text("#!/bin/sh\nexit 99\n")
        cli.chmod(0o700)
        b = f.config_data["binding"]
        self.contract = dict(schema_version=1, adapter="trae-exec-stream-v1", cli=file_ref(cli),
            runtime=b["runtime"], workspace=dict(id=b["workspace"], path=str(f.cwd)),
            operator=dict(terminal="term_operator", incarnation="inc_operator", provider="trae", session="operator"),
            coordinator={k: b[k] for k in ("terminal", "incarnation", "session")},
            runtime_config=file_ref(f.runtime), role_skill=file_ref(f.skill), handoff=file_ref(f.brief),
            skill_read_evidence=file_ref(f.brief),
            observation=dict(cursor=0, log_root=str(f.root), roots=[str(f.cwd)]),
            run=dict(id=b["run"], generation=b["generation"]))
        self.contract_file = f.root / "startup.json"
        self.save_contract()
        f.config_data["schema_version"] = 6
        clear = patch.dict(os.environ, {}, clear=True)
        clear.start()
        self.addCleanup(clear.stop)

    def save_contract(self):
        self.contract_file.write_text(json.dumps(self.contract))
        self.f.config_data["startup_contract"] = file_ref(self.contract_file)

    def test_new_driver_and_watch_share_the_same_pin(self):
        c = self.f.config()
        self.assertEqual(c.startup_contract, self.contract)
        self.assertIn(str(self.contract_file), c.control_paths)
        binding = dict(c.data["binding"])
        binding.pop("session")
        binding["expected_generation"] = binding.pop("generation")
        binding["driver_binding"] = file_ref(self.f.config_file)
        self.assertEqual(transport.watch_contract(binding), self.contract)
        binding["runtime"] = "other"
        with self.assertRaisesRegex(ValueError, "driver_identity_mismatch"):
            transport.watch_contract(binding)

    def test_missing_or_tampered_contract_is_rejected(self):
        self.contract_file.write_text("{}")
        with self.assertRaises(ValueError):
            self.f.config()
        del self.f.config_data["startup_contract"]
        with self.assertRaisesRegex(ValueError, "invalid_driver_config"):
            self.f.config()

    def test_all_run_and_coordinator_bindings_must_match(self):
        for field in ("runtime", "run", "generation", "terminal", "incarnation", "workspace", "session"):
            with self.subTest(field=field):
                d = copy.deepcopy(self.f.config_data)
                d["binding"][field] = 7 if field == "generation" else "different"
                with self.assertRaisesRegex(ValueError, "driver_startup_binding_mismatch"):
                    transport.driver_contract(d)
        self.contract["workspace"]["path"] = str(self.f.root)
        self.save_contract()
        with self.assertRaisesRegex(ValueError, "driver_startup_workspace_mismatch"):
            self.f.config()

    def test_v5_is_legacy_not_a_silent_upgrade(self):
        self.f.config_data["schema_version"] = 5
        with self.assertRaisesRegex(ValueError, "invalid_driver_config"):
            self.f.config()
        del self.f.config_data["startup_contract"]
        c = self.f.config()
        self.assertIsNone(c.startup_contract)
        with self.assertRaisesRegex(ValueError, "orca_server_cli_required"):
            driver.observe_binding(c)

    def test_driver_identity_observation_is_contract_bound_without_export(self):
        f, c = self.f, self.f.config()
        expected = self.contract["cli"]["path"]
        def query(args, runtime):
            self.assertEqual(transport.resolve(runtime), expected)
            return ({"runtime": {"appVersion": "1.4.219", "state": "ready"}} if args == ["status"]
                    else {"run": f.snapshot["run"]})
        def detail(cli, runtime, args):
            self.assertEqual(cli, expected)
            if args[:2] == ["terminal", "show"]:
                return {"terminal": dict(handle="term_test", incarnationId="inc_test", worktreeId="workspace-test",
                    worktreePath=str(f.cwd), executionHostId="local", connected=True, orphaned=False)}
            if args[:2] == ["worktree", "show"]:
                return {"worktree": dict(id="workspace-test", path=str(f.cwd))}
            return {"run": dict(id="run_test")}
        with patch.object(driver.progress_watch, "query", side_effect=query), \
                patch.object(driver, "collect_driver", return_value=f.snapshot), \
                patch.object(driver, "native", side_effect=detail):
            self.assertEqual(driver.observe_binding(c), f.snapshot)
        self.assertNotIn(transport.CLI_ENV, os.environ)

    def test_default_watch_tick_resolves_driver_chain_before_native_io(self):
        c = self.f.config()
        config = {k: v for k, v in c.data["binding"].items() if k != "session"}
        config["expected_generation"] = config.pop("generation")
        config["driver_binding"] = file_ref(self.f.config_file)
        output = self.f.root / "watch"
        output.mkdir()
        def collect(config, call):
            def query(args, runtime):
                self.assertEqual(transport.resolve(runtime), self.contract["cli"]["path"])
                raise watch.ObservationError("probe_complete")
            # Keep the real bound query wrapper; replace only its native boundary.
            with patch.object(watch.subprocess, "Popen", side_effect=lambda *a, **k: query([], config["runtime"])):
                call(["status"], config["runtime"])
        with patch.object(watch, "collect", side_effect=collect):
            state = watch.tick(config, output, {})
        self.assertEqual(state["alerts"], ["probe_complete"])
        self.contract_file.write_text("{}")
        with patch.object(watch, "collect") as native:
            watch.tick(config, output, state)
            native.assert_not_called()
        self.assertTrue((output / "query-stop.json").exists())


class MonitorContractTests(unittest.TestCase):
    def setUp(self):
        self.s = scheduler_tests.SchedulerTests()
        self.s.setUp()
        self.addCleanup(self.s.doCleanups)
        self.contract = self.s.f.c
        Path(self.contract["cli"]["path"]).chmod(0o700)
        for mock in (patch.dict(os.environ, {}, clear=True), patch.object(watch, "CLI", None)):
            mock.start()
            self.addCleanup(mock.stop)

    def test_deploy_prepare_default_transport_needs_no_environment_or_test_global(self):
        import operator_monitor_deploy as deploy
        output = self.s.m.root / "contract-deployment"
        output.mkdir(mode=0o700)
        def run(argv, **kwargs):
            self.assertEqual(argv[0], self.contract["cli"]["path"])
            result = self.s.m.fake(argv[1:-1], self.contract["runtime"])
            return SimpleNamespace(returncode=0, stdout=json.dumps(dict(ok=True,
                _meta=dict(runtimeId=self.contract["runtime"]), result=result)).encode())
        with patch.object(monitor.subprocess, "run", side_effect=run) as native:
            ref = deploy.prepare(self.s.f.config_ref, str(self.s.m.state_root), str(output))
        self.assertEqual(native.call_count, 2)
        _, config = deploy.validate(ref)
        self.assertEqual(config.startup_contract, self.contract)
        self.assertIsNone(watch.CLI)
        self.assertNotIn(transport.CLI_ENV, os.environ)


if __name__ == "__main__":
    unittest.main()
