"""Config, admission and native-adapter coverage for the `supervisor/` library half.

The fixed-DAG Sidecar (`engine`, `watchdog`, `service_finish`, `__main__`) and its `runit/`
templates were retired on 2026-11-19: no production module called them and no host ever installed
the templates. Their tests were deleted with the code rather than kept as a suite for something
that no longer exists.

What remains covers the half the rest of `swarm/` actually imports:

* `supervisor/config.py` — the reviewed contract and the `SafetyError` family
  (`configuration`, `validate`), raised by `swarm_ledger/*`, `operator_trust`, `pi_tui`;
* `supervisor/store.py` — admission, reservations and the state lock
  `swarm_ledger/binding_host.py` and `swarm_ledger/__main__.py` open;
* `supervisor/orca.py` + `trae_trust.py` — the native adapter `swarm_ledger/native.py` and
  `operator_trust.py` call.

`tests/core/test_safety.py` covers the other surviving half (`launch_guard`, `safety`,
`receipts`) and imports `config` from here, so the fixture stays in this file.
"""

import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from supervisor.config import SafetyError, task_spec, validate
from supervisor.launch_guard import target
from supervisor.orca import Orca, result
from supervisor.store import AdmissionError, Store, lock


def config(root):
    roles = ("coordinator", "implementation", "review", "integration")
    value = {
        "schema_version": 1, "goal_id": "pilot", "objective": "Test isolated modules then review and integrate",
        "enabled": False, "authorization": {}, "base_commit": "a" * 40,
        "state_dir": str(root / "state"), "artifact_dir": str(root / "artifacts"),
        "runtime": {"cli": "/approved/orca-server-cli", "version": "1.4.219", "runtime_id": "runtime-1",
                    "repo_id": "repo-1", "coordinator_worktree_id": "repo-1::/pilot/coordinator"},
        "limits": {"implementation_concurrency": 2, "total_concurrency": 2, "max_run_launches": 50,
                   "max_service_launches": 70, "max_run_seconds": 3600, "max_run_micro_usd": 10000,
                   "max_service_micro_usd": 20000, "max_period_micro_usd": 10000, "period_seconds": 86400,
                   "coordinator_reservation_micro_usd": 100, "worker_reservation_micro_usd": 200,
                   "max_failures": 3, "poll_seconds": 5, "max_round_seconds": 600,
                   "max_task_retries": 0, "max_model_upgrades": 0},
        "agents": {role: {"agent": "codex", "model": None, "effort": None} for role in roles},
        "tasks": [
            contract("a", "implementation", [], ["src/a.py"]),
            contract("b", "implementation", [], ["src/b.py"]),
            contract("review", "review", ["a", "b"], []),
            contract("integrate", "integration", ["review"], ["src/a.py", "src/b.py"]),
        ],
    }
    launch_contract(value)
    return value


def launch_contract(config):
    config["launch_contract"] = {
        "schema_version": 2, "target_sha256": target(config), "evidence_source": "synthetic-test-only",
        "roles": {role: {"approval_policy": "never", "escalation_supported": False,
                         "cli_entries": {entry: config["runtime"]["cli"] for entry in ("operator", "heartbeat", "recovery")}}
                  for role in config["agents"]}}


def contract(key, role, deps, paths):
    return {"key": key, "role": role, "goal": "Implement " + key, "depends_on": deps,
            "constraints": ["Keep approved interface"], "allowed_paths": paths, "do_not_touch": ["deploy"],
            "acceptance": {"commands": ["python3 -m unittest"], "expected_results": ["all pass"]},
            "placement": ({"kind": "exact", "worktree_id": "repo-1::/pilot/integration"} if role == "integration"
                          else {"kind": "new-top-level", "name": key})}




class Base(unittest.TestCase):
    """A validated config plus an enrolled store, with a controllable clock."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.c = config(self.root)
        validate(self.c)
        self.now = 1000
        self.s = Store(self.c["state_dir"], clock=lambda: self.now)
        self.s.enroll(self.c)

    def tearDown(self):
        self.s.close()
        self.temp.cleanup()


class ConfigurationTests(Base):
    def test_disabled_and_missing_authority_fail_live(self):
        with self.assertRaises(SafetyError):
            validate(self.c, live=True)

    def test_bad_configurations(self):
        mutations = [
            lambda c: c.update(base_commit="0" * 40),
            lambda c: c["limits"].update(max_task_retries=1),
            lambda c: c["limits"].update(max_run_micro_usd=0),
            lambda c: c["limits"].update(implementation_concurrency=3),
            lambda c: c["runtime"].update(cli="/example/.orca-relay/bin/orca"),
            lambda c: c["runtime"].update(cli="/REPLACE/approved/orca-server-cli"),
            lambda c: c["tasks"][0].update(depends_on=["b"]),
            lambda c: c["tasks"][1].update(allowed_paths=["src/a.py"]),
            lambda c: c["tasks"][0].update(allowed_paths=["../escape"]),
            lambda c: c["tasks"][0].update(allowed_paths=["deploy"]),
            lambda c: c["tasks"][2].update(allowed_paths=["src"]),
            lambda c: c["tasks"][2].update(depends_on=["a"]),
            lambda c: c["agents"]["implementation"].update(effort="high"),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                c = copy.deepcopy(self.c)
                mutation(c)
                with self.assertRaises(SafetyError):
                    validate(c)

    def test_contract_has_scope_not_conversation(self):
        spec = json.loads(task_spec(self.c, self.c["tasks"][0], {}))
        self.assertEqual(spec["ownership"]["allowed_paths"], ["src/a.py"])
        self.assertEqual(spec["base_commit"], "a" * 40)
        self.assertNotIn("history", spec)


class StoreTests(Base):
    def test_reservations_idempotent_survive_restart(self):
        self.s.reserve(self.c, "launch", "coordinator")
        self.s.reserve(self.c, "launch", "coordinator")
        self.s.pause("operator:test", goal="pilot")
        self.s.close()
        self.s = Store(self.c["state_dir"], clock=lambda: self.now)
        self.s.enroll(self.c)
        self.assertEqual(self.s.totals()["launches"], 1)
        with self.assertRaises(SafetyError):
            self.s.reserve(self.c, "next", "coordinator")

    def test_changed_goal_and_service_policy_refused(self):
        c = copy.deepcopy(self.c)
        c["objective"] = "new objective"
        with self.assertRaises(SafetyError):
            self.s.enroll(c)
        c["goal_id"] = "new-goal"
        c["limits"]["max_service_launches"] += 1
        with self.assertRaises(SafetyError):
            self.s.enroll(c)

    def test_new_goal_does_not_reset_service_budget(self):
        self.c["limits"]["max_service_launches"] = 1
        self.s.reserve(self.c, "one", "coordinator")
        c = copy.deepcopy(self.c)
        c["goal_id"] = "two"
        self.s.put("two:started", self.now)
        with self.assertRaises(SafetyError):
            self.s.reserve(c, "two", "coordinator")

    def test_unknown_cost_conservative_and_overrun_pauses(self):
        self.s.reserve(self.c, "cost", "coordinator")
        self.assertEqual(self.s.totals()["unknown_actual_count"], 1)
        self.assertEqual(self.s.totals()["charged_micro_usd"], 100)
        self.s.cost("cost", 101, "provider invoice", {})
        self.assertEqual(self.s.get("service:pause"), "actual_cost_exceeded_reservation")
        self.s.cost("cost", 101, "provider invoice", {})
        with self.assertRaises(SafetyError):
            self.s.cost("cost", 0, "other", {})

    def test_lost_operation_receipt_never_replayed(self):
        calls = []

        def uncertain(args):
            calls.append(args)
            raise SafetyError("transport lost")

        for _ in range(2):
            with self.assertRaises(SafetyError):
                self.s.operation("pilot", "op", ["start"], uncertain)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.s.pending("pilot"), ["op"])

    def test_received_operation_replayed_locally(self):
        calls = []
        for _ in range(2):
            self.s.operation("pilot", "op", ["start"], lambda a: calls.append(a) or {"ok": True})
        self.assertEqual(len(calls), 1)

    def test_single_instance_lock(self):
        with lock(self.s.root, "instance.lock"):
            with self.assertRaises(SafetyError):
                with lock(self.s.root, "instance.lock"):
                    pass
        with lock(self.s.root, "instance.lock"):
            pass

    def test_backoff_and_circuit_survive_success(self):
        for expected in (10, 20, 40):
            self.s.failure(self.c["limits"], "test")
            self.assertEqual(self.s.get("service:retry_after"), self.now + expected)
        self.assertEqual(self.s.get("service:pause"), "supervisor_circuit_open")

    def test_permissions(self):
        self.assertEqual(self.s.root.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.s.root / "policy.sqlite3").stat().st_mode & 0o777, 0o600)

    def test_budget_failures_persist_outside_rollback(self):
        limits = {
            "max_run_launches": "run_launch_budget_exhausted",
            "max_service_launches": "service_launch_budget_exhausted",
            "max_run_micro_usd": "run_spend_budget_exhausted",
            "max_service_micro_usd": "service_spend_budget_exhausted",
            "max_period_micro_usd": "period_spend_budget_exhausted",
        }
        self.s.reserve(self.c, "first", "coordinator")
        for name, reason in limits.items():
            with self.subTest(name=name):
                c = copy.deepcopy(self.c)
                c["limits"][name] = 1 if name.endswith("launches") else 100
                self.s.put("pilot:pause", None)  # Isolate test cases; not an operator recovery API.
                with self.assertRaises(AdmissionError):
                    self.s.reserve(c, "second", "coordinator")
                self.assertEqual(self.s.get("pilot:pause"), reason)
                self.assertEqual(self.s.totals()["launches"], 1)

    def test_duration_budget_is_persistent(self):
        self.now += 3600
        with self.assertRaises(AdmissionError):
            self.s.reserve(self.c, "late", "coordinator")
        self.assertEqual(self.s.get("pilot:pause"), "run_duration_exhausted")

    def test_operator_cannot_overwrite_safety_pause(self):
        self.s.pause("unresolved_operation:test", goal="pilot")
        self.s.pause("operator:temporary", goal="pilot")
        self.assertEqual(self.s.get("pilot:pause"), "unresolved_operation:test")




class AdapterTests(Base):
    def test_trust_preflight_refuses_foreign_host_path_and_repo(self):
        target = "repo-1::" + str(self.root)
        row = {"id": target, "repoId": "repo-1", "path": str(self.root), "hostId": "local"}
        for field, value in (("hostId", "ssh:remote"), ("path", "/"), ("repoId", "foreign")):
            bad = {**row, field: value}
            with self.subTest(field=field), self.assertRaises(SafetyError):
                self.adapter([self.envelope({"repo": {"id": "repo-1"}}),
                              self.envelope({"worktree": bad})]).preflight(target, for_trust=True)

    def test_trust_preflight_checks_new_workspace_baseline(self):
        target = "repo-1::" + str(self.root)
        row = {"id": target, "repoId": "repo-1", "path": str(self.root), "hostId": "local"}
        rows = [self.envelope({"repo": {"id": "repo-1"}}), self.envelope({"worktree": row})]
        rows += [subprocess.CompletedProcess([], 0, value, "")
                 for value in (str(self.root), "", "", "b" * 40)]
        with self.assertRaisesRegex(SafetyError, "different baseline"):
            self.adapter(rows).preflight(target, for_trust=True, expected_head="a" * 40)

    def adapter(self, responses):
        iterator = iter(responses)
        return Orca(self.c, env={}, runner=lambda *a, **kw: next(iterator))

    def envelope(self, data, code=0, runtime="runtime-1"):
        return subprocess.CompletedProcess([], code, json.dumps({"ok": True, "result": data, "_meta": {"runtimeId": runtime}}), "private error")

    def test_exit_one_still_preserves_receipt(self):
        adapter = self.adapter([self.envelope({"state": "failed", "residualResources": {}}, 1)])
        self.assertEqual(result(adapter.invoke(["orchestration", "worker-start"]))["state"], "failed")

    def test_error_at_exit_zero_not_success(self):
        adapter = self.adapter([subprocess.CompletedProcess([], 0, json.dumps({"ok": False, "error": {"code": "denied", "message": "SECRET"}}), "SECRET")])
        with self.assertRaisesRegex(SafetyError, "^native:denied$"):
            adapter.read("status")

    def test_foreign_runtime_refused(self):
        adapter = self.adapter([self.envelope({}, runtime="desktop-runtime")])
        with self.assertRaises(SafetyError):
            adapter.read("status")

    def test_pagination_complete_and_repeat_cursor_refused(self):
        page1 = {"workers": [{"dispatchId": "d1"}], "page": {"hasMore": True, "nextCursor": "opaque"}}
        page2 = {"workers": [{"dispatchId": "d2"}], "page": {"hasMore": False}}
        adapter = self.adapter([self.envelope(page1), self.envelope(page2)])
        self.assertEqual(len(adapter.workers("run")), 2)
        adapter = self.adapter([self.envelope(page1), self.envelope(page1)])
        with self.assertRaises(SafetyError):
            adapter.workers("run")

    def test_more_than_100_worker_pages(self):
        pages = [self.envelope({"workers": [{"dispatchId": f"d{i}"}],
            "page": {"hasMore": i < 104, "nextCursor": str(i + 1)}}) for i in range(105)]
        self.assertEqual(len(self.adapter(pages).workers("run")), 105)

    def test_partial_host_failure_refused(self):
        adapter = self.adapter([self.envelope({"workers": [], "page": {"hasMore": False}, "partialHostErrors": ["lost host"]})])
        with self.assertRaises(SafetyError):
            adapter.workers("run")

    def test_no_spoofing_or_route_override(self):
        for env in ({"ORCA_ENVIRONMENT": "desktop"}, {"ORCA_TERMINAL_HANDLE": "other"}):
            with self.assertRaises(SafetyError):
                Orca(self.c, env=env)
        adapter = self.adapter([])
        with self.assertRaises(SafetyError):
            adapter.invoke(["orchestration", "run-create", "--from", "other"])
        with self.assertRaises(SafetyError):
            adapter.identity()

    def test_preflight_exact_local_checkout_and_base(self):
        target = "repo-1::" + str(self.root)
        rows = [self.envelope({"repo": {"id": "repo-1"}}), self.envelope({"worktree": {"id": target}}),
                subprocess.CompletedProcess([], 0, str(self.root) + "\n", ""),
                subprocess.CompletedProcess([], 0, "", ""), subprocess.CompletedProcess([], 0, "", "")]
        self.adapter(rows).preflight(target)
        for index, replacement in (
            (0, self.envelope({"repo": {"id": "other"}})),
            (1, self.envelope({"worktree": {"id": "other"}})),
            (3, subprocess.CompletedProcess([], 128, "", "unknown SHA")),
            (4, subprocess.CompletedProcess([], 0, " M important.py\n", "")),
        ):
            with self.subTest(index=index):
                bad = rows.copy()
                bad[index] = replacement
                with self.assertRaises(SafetyError):
                    self.adapter(bad).preflight(target)

    def test_transport_error_has_no_stderr(self):
        def fail(*args, **kwargs):
            raise subprocess.TimeoutExpired(args[0], 55, stderr="SECRET")
        native = Orca(self.c, env={}, runner=fail)
        with self.assertRaisesRegex(SafetyError, "^native_transport_unknown$"):
            native.invoke(["status"])




if __name__ == "__main__":
    unittest.main()
