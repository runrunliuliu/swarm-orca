"""Offline only: fixture executors/native data, never a real Agent or Orca mutation."""
from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timedelta, timezone
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import coordinator_driver as driver
import coordinator_launch as launch
from coordinator_loop import phase_contract
from coordinator_input import input_bytes
from trae_coordinator import AUTO_REVIEW_EXECUTION, build_trae_plan


SID = "12345678-1234-1234-1234-123456789012"
# A tiny pinned package tests the checker transport independently of fin_verl.
# Full FIN schema acceptance is owned by rsi.progress's tests, not reimplemented here.
CHECKER_FIXTURE = '''import hashlib, json
def check_progress(record, contract, pin):
    assert record["schema_version"] == 2
    assert record["run_id"] == contract["run_id"]
    assert record["objective_ref"] == contract["objective_ref"]
    assert record["contract_sha256"] == pin
    assert record["decision"] in {"continue", "wait", "blocked", "complete"}
    assert hashlib.sha256(json.dumps(contract,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest() == pin
    return {"schema_version":2, "consistent":True, "decision":record["decision"],
            "contract_sha256":pin, "execution_authorized":False}
'''

AUTHORITY_FIXTURE = '''import hashlib, json, pathlib
from rsi.progress import check_progress
def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
def resolve_authority(ledger, pin, *, source_root, run_id, scope_id):
    assert digest(ledger) == pin and ledger["run_id"] == run_id and ledger["scope_id"] == scope_id
    fields, origins = {}, {}
    for event in ledger["events"]:
        source = event["source"]
        raw = (pathlib.Path(source_root) / source["path"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == source["sha256"] and source["excerpt"] in raw.decode()
        assert event["actor"] == "user"
        fields.update(event["patch"])
        origins.update({k:event["id"] for k in event["patch"]})
    return dict(schema_version=1,run_id=run_id,scope_id=scope_id,authority_sha256=pin,fields=fields,origins=origins)
def check_authorized_progress(record,contract,pin,resolved,handoff,context,context_pin,gates):
    assert resolved == handoff and digest(context) == context_pin
    paths = {r["id"]:r for r in record["paths"]}
    bindings = {r["id"]:r for r in context["paths"]}
    rows = {r["id"]:r for r in gates["paths"]}
    assert paths.keys() == bindings.keys() == rows.keys()
    for key,p in paths.items():
        assert bindings[key]["operation"] == p["operation"]
        if p["status"] == "actionable":
            assert all(resolved["fields"]["permissions."+v] == "granted" for v in bindings[key]["permissions"])
            assert rows[key]["technical"] == "ready" and rows[key]["platform"] == "allowed"
    return dict(check_progress(record,contract,pin),authority_declarations_evaluated=True,
        validation_scope="pinned_authority_context_and_declared_gates",authority_sha256=resolved["authority_sha256"],
        context_sha256=context_pin)
'''

PROCESS_FIXTURE = '''import datetime, hashlib, json, pathlib, subprocess, sys
start = datetime.datetime.now(datetime.timezone.utc).isoformat()
text = sys.stdin.read()
protocol = json.loads(text[text.index("\\n{\\n") + 1:])
skill = protocol["repository_skills"]["roles"]["coordinator"]
assert hashlib.sha256(pathlib.Path(skill["path"]).read_bytes()).hexdigest() == skill["sha256"]
pathlib.Path(protocol["action_acceptance_output"]).write_text(json.dumps({
    "schema_version":2, "action":protocol["action"], "accepted_at":start, "skills_read":[skill]}))
target = pathlib.Path(protocol["checkpoint_output"])
count = int(target.parent.name.split("-")[1])
artifact = pathlib.Path(protocol["progress_roots"][0]) / "actual-process-output.py"
artifact.write_text("actual child output version " + str(count))
record = protocol["incoming_checkpoint"]
record["observed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
if count == 2:
    record["decision"] = "complete"
    record["next_action"] = None
    record["paths"] = []
    record["requirements"][0].update(status="met", path_review_ref=None,
        evidence=[{"kind":"artifact", "ref":str(artifact)}])
target.write_text(json.dumps(record))
pathlib.Path(protocol["gates_output"]).write_text(json.dumps({"schema_version":1,"paths":[
    {"id":p["id"],"technical":"ready","platform":"allowed","evidence_refs":["fixture-proof"]}
    for p in record["paths"]]}))
pathlib.Path(protocol["action_result_output"]).write_text(json.dumps({
    "schema_version":2, "action":protocol["action"], "status":"executed", "waiting_dispatches":[], "artifacts":[{
    "kind":"source", "path":str(artifact), "sha256":hashlib.sha256(artifact.read_bytes()).hexdigest()}]}))
validation = subprocess.run(protocol["checkpoint_validation_argv"], capture_output=True, text=True)
assert validation.returncode == 0, validation.stdout + validation.stderr
assert json.loads(validation.stdout)["status"] == "checkpoint_draft_consistent_not_execution_or_acceptance"
log = pathlib.Path(SESSION_LOG)
events = [json.loads(line) for line in log.read_text().splitlines()]
events[-1]["timestamp"] = start
log.write_text("".join(json.dumps(e) + "\\n" for e in events))
print(json.dumps({"type":"thread.started", "thread_id":protocol["binding"]["session"]}))
print(json.dumps({"type":"item.completed", "item":{"type":"file_change", "status":"completed",
    "id":"fixture-item", "changes":[{"path":str(artifact), "kind":"update"}]}}))
print(json.dumps({"type":"turn.completed", "usage":{"input_tokens":3, "output_tokens":4}}))
'''


class DriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.cwd = self.root / "work tree"
        self.archive = self.root / "run_test"
        self.checker = self.root / "checker"
        for target in (self.cwd, self.archive, self.checker / "rsi"):
            target.mkdir(parents=True)
        self.skill = self.add_skill("coordinator")
        self.researcher_skill = self.add_skill("researcher")
        self.write(self.checker / "rsi/__init__.py", "")
        self.write(self.checker / "rsi/progress.py", CHECKER_FIXTURE)
        self.write(self.checker / "rsi/authority.py", AUTHORITY_FIXTURE)
        # Optional integration mode executes the actual pinned FIN checker package.
        # No checkout mutation, external service, model, or native Orca calls.
        self.real_checker = bool(os.environ.get("RSI_CHECKER_TEST_ROOT"))
        if self.real_checker:
            source_root = Path(os.environ["RSI_CHECKER_TEST_ROOT"]).resolve(strict=True)
            for source in (source_root / "rsi").rglob("*.py"):
                dest = self.checker / source.relative_to(source_root)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(source.read_bytes())
        self.brief = self.root / "brief.md"
        self.write(self.brief, "Original authorized task, no new budget or scope.")
        self.runtime = self.root / "runtime.json"
        self.write(self.runtime, {"schema_version": 1, "scope": "swarm_coordinator_only",
            "provider": "trae", "cli_version": "0.210.1", "execution": AUTO_REVIEW_EXECUTION})
        self.plan = build_trae_plan(trae=sys.executable, cwd=self.cwd,
            archive_dir=self.archive, write_dirs=[], selection=driver.SELECTION,
            runtime_config=self.runtime, prompt_file=self.brief, bootstrap_dir=None, resume_session=SID)
        self.previous = self.archive / "previous-plan.json"
        self.write(self.previous, self.plan)
        self.contract = {"schema_version": 1, "run_id": "run_test", "objective_ref": "approved-task",
            "authorization_ref": "user-request", "requirements": [
                {"id": "benchmark", "acceptance": "measured held-out improvement", "evidence_kind": "artifact"}]}
        self.contract_file = self.root / "contract.json"
        self.write(self.contract_file, self.contract)
        self.log = self.root / "session.jsonl"
        self.start = datetime.now(timezone.utc) - timedelta(seconds=3)
        self.end = self.start + timedelta(seconds=2)
        self.checkpoint_file = self.archive / "initial-checkpoint.json"
        self.write(self.checkpoint_file, self.checkpoint("continue", self.start + timedelta(seconds=1)))
        self.receipts(self.previous, self.start, self.end)
        self.session_log(self.start + timedelta(milliseconds=10))
        self.config_file = self.root / "driver.json"
        self.gates_file = self.archive / "initial-gates.json"
        self.write(self.gates_file, self.gates(self.checkpoint("continue")))
        self.config_data = {"schema_version": 5, "enabled": True, "authorization_ref": "explicit-driver-approval",
            "outer_operator": {"id": "submit-operator"},
            "binding": {"runtime": "runtime-test", "run": "run_test", "generation": 6,
                "terminal": "term_test", "incarnation": "inc_test", "workspace": "workspace-test", "session": SID},
            "previous_plan": driver.file_ref(self.previous),
            "initial_checkpoint": driver.file_ref(self.checkpoint_file), "initial_waiting_dispatches": [],
            "initial_gates": driver.file_ref(self.gates_file),
            "contract": {"path": str(self.contract_file), "sha256": driver.digest(driver.canonical(self.contract))},
            "brief": driver.file_ref(self.brief), "session_log": str(self.log),
            "checker": {"root": str(self.checker), "files": self.manifest()},
            "repository_skills": {role: refs[0] for role, refs in driver.discover_repository_skills(self.cwd).items()},
            "progress_roots": [str(self.cwd)],
            "limits": {"max_workers": 16, "max_training_trials": 1,
                       "max_no_progress_turns": 2, "wait_poll_seconds": 1}}
        permissions = "research local_edit agent_launch training evaluation commit push deploy resource_expansion credentials cleanup promotion".split()
        limits = "max_workers max_concurrent_training_trials time_seconds tokens worker_attempts recovery_attempts".split()
        fields = {**{"permissions." + k: "granted" if k in {"research", "local_edit"} else "denied" for k in permissions},
                  **{"limits." + k: {"mode": "unknown"} for k in limits},
                  "models.judge": "example-judge-model", "models.simulator": "example-judge-model"}
        fields["limits.max_workers"] = {"mode": "bounded", "value": 16}
        fields["limits.max_concurrent_training_trials"] = {"mode": "bounded", "value": 1}
        self.ledger_file = self.root / "authority-ledger.json"
        self.handoff_file = self.root / "authority-handoff.json"
        self.catalog_file = self.root / "authority-catalog.json"
        ledger = {"schema_version": 1, "run_id": "run_test", "scope_id": "research",
                  "events": [{"id": "user-source", "actor": "user",
                    "source": {"path": self.brief.name, "sha256": driver.file_ref(self.brief)["sha256"],
                               "excerpt": "Original authorized task"}, "patch": fields}]}
        self.write(self.ledger_file, ledger)
        ledger_pin = driver.digest(driver.canonical(ledger))
        self.write(self.handoff_file, {"schema_version": 1, "run_id": "run_test", "scope_id": "research",
            "authority_sha256": ledger_pin, "fields": fields, "origins": dict.fromkeys(fields, "user-source")})
        self.write(self.catalog_file, {"schema_version": 1, "run_id": "run_test", "scope_id": "research",
            "authority_sha256": ledger_pin, "contract_sha256": self.config_data["contract"]["sha256"],
            "paths": [{"id": "path", "operation": "produce verified source", "permissions": ["local_edit"]}]})
        self.config_data["authority"] = {"ledger": self.json_ref(self.ledger_file),
            "source_root": str(self.root), "scope_id": "research",
            "handoff": self.json_ref(self.handoff_file), "path_catalog": self.json_ref(self.catalog_file)}
        self.snapshot = {"run": {"id": "run_test", "consumer_generation": 6,
                "coordinator_handle": "term_test"}, "workers": [], "tasks": [],
                "terminals": [], "inventory_complete": True}
        self.captured = []
        self.script = []

    @staticmethod
    def write(target, value):
        target.write_text(value if isinstance(value, str) else json.dumps(value))

    def add_skill(self, role, directory=".agents/skills"):
        target = self.cwd / directory / ("fin-verl-rsi-" + role) / "SKILL.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        self.write(target, "---\nname: fin-verl-rsi-" + role + "\n---\nRead the target context before work.\n")
        return target

    def manifest(self):
        return {str(p.relative_to(self.checker)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in (self.checker / "rsi").rglob("*.py")}

    def config(self):
        self.write(self.config_file, self.config_data)
        return driver.Config(str(self.config_file), hashlib.sha256(self.config_file.read_bytes()).hexdigest())

    @staticmethod
    def json_ref(target):
        return {"path": str(target), "sha256": driver.digest(driver.canonical(driver.read_json(target)))}

    @staticmethod
    def gates(record):
        return {"schema_version": 1, "paths": [{"id": p["id"],
            "technical": "not_ready" if p["status"] == "waiting" else "ready",
            "platform": "denied" if p["status"] == "blocked" else "allowed", "evidence_refs": ["fixture-proof"]}
            for p in record["paths"]]}

    def initial(self, record):
        self.write(self.checkpoint_file, record)
        self.write(self.gates_file, self.gates(record))
        self.config_data["initial_checkpoint"] = driver.file_ref(self.checkpoint_file)
        self.config_data["initial_gates"] = driver.file_ref(self.gates_file)

    def checkpoint(self, decision, at=None):
        status = {"continue": "actionable", "wait": "waiting", "blocked": "blocked", "complete": "met"}[decision]
        requirement = dict(self.contract["requirements"][0], status=status,
            evidence=[{"kind": "artifact", "ref": "fixture-proof"}] if status == "met" else [],
            path_review_ref=None if status == "met" else "fixture-reviewed-paths")
        barriers = []
        barrier = None if status == "actionable" else "barrier"
        if decision in {"wait", "blocked"}:
            barriers = [{"id": "barrier", "kind": "dependency_running" if decision == "wait" else "permission_denied",
                "path_ids": ["path"], "evidence_refs": ["native-proof"], "condition": "native dependency change",
                "attempt_refs": [], "recovery_limit": None,
                "alternatives_ref": None if decision == "wait" else "alternatives-reviewed"}]
        return {"schema_version": 2, "run_id": "run_test", "observed_at": (at or datetime.now(timezone.utc)).isoformat(),
            "objective_ref": self.contract["objective_ref"], "contract_sha256": driver.digest(driver.canonical(self.contract)),
            "requirements": [requirement], "paths": [] if decision == "complete" else [
                {"id": "path", "requirement_id": "benchmark", "operation": "produce verified source",
                 "status": status, "barrier_id": barrier}], "barriers": barriers, "claim_limits": [],
            "decision": decision, "next_action": None if decision in {"complete", "blocked"} else {
                "id": "measure", "owner": "coordinator", "kind": "wait" if decision == "wait" else "implement",
                "path_ids": ["path"], "deliverables": ["source"], "validation": "run tests",
                "prerequisites": [], "expected_outputs": ["artifact"]}}

    def session_log(self, at):
        meta = {"type": "session_meta", "payload": {"id": SID, "session_id": SID,
            "cli_version": "0.210.1", "model_provider": "trae", "cwd": str(self.cwd),
            "source": "exec", "originator": "codex_exec", "parent_thread_id": None}}
        context = {"type": "turn_context", "timestamp": at.isoformat(), "payload": {
            "model": "GPT-5.5", "model_provider": "trae", "effort": "xhigh", "model_backend_variant": "max",
            "cwd": str(self.cwd), "approval_policy": "on-request", "approvals_reviewer": "guardian_subagent",
            "sandbox_policy": {"type": "workspace-write", "network_access": True,
                               "writable_roots": self.plan["task_write_roots"]}}}
        self.write(self.log, json.dumps(meta) + "\n" + json.dumps(context) + "\n")

    def receipts(self, plan_file, start, end, *, tool=True):
        stdin = input_bytes(driver.read_json(plan_file))
        plan_file.with_suffix(".stdin.md").write_bytes(stdin)
        intent = {"started_at": start.isoformat(), "plan_sha256": driver.file_ref(plan_file)["sha256"],
                  "phase": "run", "resume_session": SID, "stdin_sha256": driver.digest(stdin)}
        self.write(plan_file.with_suffix(".process-intent.json"), intent)
        self.write(plan_file.with_suffix(".process.json"), dict(intent, ended_at=end.isoformat(),
            child_pid=1234, exit_code=0, stream_errors=[], observed_by="direct-parent-wait-not-signed-attestation"))
        events = [{"type": "thread.started", "thread_id": SID}]
        if tool:
            events.append({"type": "item.completed", "item": {"id": "item-1", "type": "command_execution",
                          "command": "fixture-tests", "status": "completed", "exit_code": 0,
                          "aggregated_output": "passed"}})
        events.append({"type": "turn.completed", "usage": {"input_tokens": 4, "output_tokens": 5}})
        self.write(plan_file.with_suffix(".stdout.jsonl"), "".join(json.dumps(e) + "\n" for e in events))

    def capture(self, plan_file, output):
        self.captured.append(driver.read_json(plan_file))
        step = self.script.pop(0)
        start = datetime.now(timezone.utc)
        text = Path(self.captured[-1]["prompt_file"]).read_text()
        protocol = json.loads(text[text.index("\n{\n") + 1:])
        self.write(plan_file.parent / "action-accepted.json", {"schema_version": 2,
                   "action": protocol["action"], "accepted_at": start.isoformat(),
                   "skills_read": [protocol["repository_skills"]["roles"]["coordinator"]]})
        self.session_log(start)
        artifact_list = []
        if step.get("artifact") is not None:
            artifact = self.cwd / step.get("filename", "result.py")
            self.write(artifact, step["artifact"])
            artifact_list.append(dict(driver.file_ref(artifact), kind=step.get("artifact_kind", "source")))
        record = step.get("record") or self.checkpoint(step.get("decision", "continue"))
        record["observed_at"] = datetime.now(timezone.utc).isoformat()
        self.write(plan_file.parent / "checkpoint.json", record)
        self.write(plan_file.parent / "gates.json", self.gates(record))
        self.write(plan_file.parent / "action-result.json", {"schema_version": 2, "action": protocol["action"],
                   "status": step.get("status", "executed" if artifact_list else "no_progress"),
                   "artifacts": artifact_list, "waiting_dispatches": step.get("waiting_dispatches", [])})
        if "draft" in step:
            # Model has started and written outputs, but no exit/settlement exists yet.
            stdin = input_bytes(self.captured[-1])
            plan_file.with_suffix(".stdin.md").write_bytes(stdin)
            self.write(plan_file.with_suffix(".process-intent.json"), {
                "started_at": start.isoformat(), "plan_sha256": driver.file_ref(plan_file)["sha256"],
                "phase": "run", "resume_session": SID, "stdin_sha256": driver.digest(stdin)})
            step["draft"](plan_file, protocol)
        self.receipts(plan_file, start, datetime.now(timezone.utc), tool=step.get("tool", True))
        if "mutate" in step:
            step["mutate"](plan_file)
        return step.get("code", 0)

    @contextmanager
    def journal(self, config=None):
        config = config or self.config()
        with driver.Journal(config.root, config.sha256).locked() as journal:
            yield config, journal

    def run_driver(self, config, journal, **kwargs):
        return driver.drive(config, journal, capture=self.capture,
                            fence=lambda _: copy.deepcopy(self.snapshot), output=io.BytesIO(), **kwargs)

    def test_continue_executes_two_turns_preserving_session_and_permissions(self):
        self.script = [{"artifact": "real source v1"}, {"artifact": "real source v2", "decision": "complete"}]
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "complete_pending_independent_acceptance")
            self.assertEqual(journal.data["attempts"], 2)
            self.assertEqual(journal.data["no_progress_turns"], 0)
            self.assertIsNone(journal.data["pending"])
            for captured in self.captured:
                for key in ("argv", "cwd", "execution", "resume_session", "task_write_roots"):
                    self.assertEqual(captured[key], self.plan[key])
            receipts = sorted(config.root.glob("turn-*/action-receipt.json"))
            self.assertEqual(len(receipts), 2)
            self.assertEqual(driver.read_json(receipts[0])["stream"]["usage"]["input_tokens"], 4)

    def test_wave_marker_and_final_report_continue_to_next_actual_action(self):
        def wave_report(plan):
            stream = plan.with_suffix(".stdout.jsonl")
            marker = {"type": "item.completed", "item": {"type": "agent_message",
                      "text": "Final report: WAVE1_RESULTS_READY. next_decision=continue_review"}}
            events = [json.loads(line) for line in stream.read_text().splitlines()]
            events.insert(-1, marker)  # Real model output precedes turn.completed.
            self.write(stream, "".join(json.dumps(event) + "\n" for event in events))
        after_wave = self.checkpoint("continue")
        after_wave["next_action"].update(id="independent-review", validation="review first action evidence")
        self.script = [{"artifact": "first action evidence", "record": after_wave, "mutate": wave_report},
                       {"artifact": "independent review evidence", "decision": "complete"}]
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "complete_pending_independent_acceptance")
            self.assertEqual(journal.data["operator_requests"], {})
            self.assertEqual(journal.data["attempts"], 2)
        protocols = []
        for plan in self.captured:
            text = Path(plan["prompt_file"]).read_text()
            self.assertIn(phase_contract("run"), text)
            self.assertNotIn("MUST NOT dispatch", text)
            protocols.append(json.loads(text[text.index("\n{\n") + 1:]))
        self.assertEqual([p["action"]["action_id"] for p in protocols], ["measure", "independent-review"])
        self.assertEqual({p["binding"]["session"] for p in protocols}, {SID})

    def test_marker_without_checkpoint_does_not_complete_or_replay(self):
        def only_marker(plan):
            (plan.parent / "checkpoint.json").unlink()
            stream = plan.with_suffix(".stdout.jsonl")
            marker = {"type": "item.completed", "item": {"type": "agent_message",
                      "text": "WAVE1_RESULTS_READY. final report complete"}}
            events = [json.loads(line) for line in stream.read_text().splitlines()]
            events.insert(-1, marker)
            self.write(stream, "".join(json.dumps(event) + "\n" for event in events))
        self.script = [{"mutate": only_marker}]
        with self.journal() as (config, journal):
            with self.assertRaises(FileNotFoundError):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])
            self.assertEqual(driver.read_json(journal.data["current"]["checkpoint"]["path"])["decision"], "continue")
            self.assertEqual(self.run_driver(config, journal), "pending_launch_requires_reconciliation")
        self.assertEqual(len(self.captured), 1)

    def test_local_blocker_keeps_independent_actions_in_coordinator_loop(self):
        blocked = self.checkpoint("blocked")
        alternate = dict(blocked["paths"][0], id="blocked-alternative", barrier_id="local-boundary")
        boundary = dict(blocked["barriers"][0], id="local-boundary", path_ids=[alternate["id"]])
        mixed = self.checkpoint("continue", self.start + timedelta(seconds=1))
        mixed["paths"].append(alternate)
        mixed["barriers"].append(boundary)
        catalog = driver.read_json(self.catalog_file)
        catalog["paths"].append(dict(catalog["paths"][0], id=alternate["id"]))
        self.write(self.catalog_file, catalog)
        self.config_data["authority"]["path_catalog"] = self.json_ref(self.catalog_file)
        self.initial(mixed)
        next_record = copy.deepcopy(mixed)
        next_record["next_action"]["id"] = "independent-review"
        blocked["paths"].append(alternate)
        blocked["barriers"].append(boundary)
        self.script = [{"record": next_record, "artifact": "independent readiness"},
                       {"record": blocked, "artifact": "independent review proves remaining boundary"}]
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "blocked_pending_independent_alternatives_review")
            self.assertEqual(journal.data["attempts"], 2)
            self.assertEqual(journal.data["operator_requests"], {})
        self.assertTrue(all(plan["resume_session"] == SID for plan in self.captured))

    def test_shared_route_rejects_global_wait_while_ready_work_remains(self):
        record = self.checkpoint("continue")
        record["decision"] = "wait"
        record["next_action"]["kind"] = "wait"
        self.script = [{"record": record, "artifact": "a report cannot hide ready work"}]
        with self.journal() as (config, journal):
            # The real RSI rejects this earlier than the routing-only fixture.
            reason = ("checkpoint_validation_failed" if self.real_checker else
                      "checkpoint_decision_conflicts_with_remaining_work")
            with self.assertRaisesRegex(ValueError, reason):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])
            self.assertEqual(driver.read_json(journal.data["current"]["checkpoint"]["path"])["decision"], "continue")
        self.assertEqual(len(self.captured), 1)

    def test_research_claim_gap_preserves_authorized_analysis_without_training(self):
        # Regression shape of run_e90984a07d96, not its private data or authorization.
        record = self.checkpoint("continue", self.start + timedelta(seconds=1))
        record["requirements"][0]["path_review_ref"] = "joint-key-and-official-identity-gap-review"
        record["paths"][0]["operation"] = "inspect producer provenance and extraction feasibility"
        record["paths"].append({"id": "producer", "requirement_id": "benchmark",
            "operation": "run producer training", "status": "blocked", "barrier_id": "training-gate"})
        barrier = self.checkpoint("blocked")["barriers"][0]
        barrier.update(id="training-gate", path_ids=["producer"])
        record["barriers"] = [barrier]
        record["next_action"].update(id="inspect-provenance", kind="research",
            deliverables=["source-grounded extraction analysis"], validation="review exact source references")
        catalog = driver.read_json(self.catalog_file)
        catalog["paths"] = [
            {"id": p["id"], "operation": p["operation"],
             "permissions": ["research" if p["id"] == "path" else "training"]} for p in record["paths"]]
        self.write(self.catalog_file, catalog)
        self.config_data["authority"]["path_catalog"] = self.json_ref(self.catalog_file)
        self.initial(record)
        review = copy.deepcopy(record)
        review["next_action"].update(id="review-extraction", kind="review",
                                    deliverables=["feasibility review"])
        final = copy.deepcopy(review)
        final.update(decision="blocked", next_action=None)
        final["requirements"][0]["status"] = "blocked"
        # The reviewed prerequisite is done; the producer gate stays, benchmark unmet.
        final["paths"] = [final["paths"][1]]
        self.script = [
            {"record": review, "artifact_kind": "analysis", "filename": "extraction.md",
             "artifact": "Inspected producer fields: candidate keys cannot provide official identity."},
            {"record": final, "artifact_kind": "analysis", "filename": "review.md",
             "artifact": "Source refs verified; alternatives compared; benchmark remains unproven."}]
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "blocked_pending_independent_alternatives_review")
            self.assertEqual(journal.data["attempts"], 2)
            self.assertEqual(journal.data["no_progress_turns"], 0)
            self.assertEqual(driver.read_json(journal.data["current"]["checkpoint"]["path"])["requirements"][0]["status"],
                             "blocked")
        self.assertEqual(self.snapshot["workers"], [])
        for plan in self.captured:
            self.assertEqual(plan["resume_session"], SID)
            text = Path(plan["prompt_file"]).read_text()
            action = json.loads(text[text.index("\n{\n") + 1:])["incoming_checkpoint"]["next_action"]
            self.assertEqual(action["path_ids"], ["path"])

    def test_draft_rejects_custom_decision_then_accepts_same_turn_correction_read_only(self):
        def validate(plan, protocol):
            state = (config.root / "state.json").read_bytes()
            events = (config.root / "events.jsonl").read_bytes()
            checkpoint = plan.parent / "checkpoint.json"
            valid = driver.read_json(checkpoint)
            self.write(checkpoint, dict(valid,
                decision="wait_for_producer_side_no_content_sidecar_or_operator_decision"))
            argv = protocol["checkpoint_validation_argv"][3:]
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(driver.main(argv), 2)
            self.assertEqual(json.loads(output.getvalue())["reason"], "invalid_checkpoint_decision")
            self.write(checkpoint, valid)
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(driver.main(argv), 0)
            self.assertFalse(json.loads(output.getvalue())["business_accepted"])
            self.assertEqual((config.root / "state.json").read_bytes(), state)
            self.assertEqual((config.root / "events.jsonl").read_bytes(), events)
            self.assertFalse(plan.with_suffix(".process.json").exists())
            self.assertFalse((plan.parent / "settlement.json").exists())
        self.script = [{"artifact": "verified result", "decision": "complete", "draft": validate}]
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "complete_pending_independent_acceptance")
            self.assertEqual(journal.data["attempts"], 1)
        self.assertEqual(len(self.captured), 1)  # Fixing metadata never repeats the business action.

    def test_draft_rejects_wrong_outputs_identity_and_stop_without_settling(self):
        def validate(plan, protocol):
            checkpoint, gates = protocol["checkpoint_output"], protocol["gates_output"]
            before = (config.root / "state.json").read_bytes()
            with self.assertRaisesRegex(ValueError, "draft_output_path_mismatch"):
                driver.check_draft(config, str(self.checkpoint_file), gates)
            intent_file = plan.with_suffix(".process-intent.json")
            intent = driver.read_json(intent_file)
            self.write(intent_file, dict(intent, resume_session="another-session"))
            with self.assertRaisesRegex(ValueError, "draft_turn_binding_mismatch"):
                driver.check_draft(config, checkpoint, gates)
            self.write(intent_file, intent)
            self.write(config.root / "STOP", "operator stop")
            with self.assertRaisesRegex(ValueError, "no_active_checkpoint_draft"):
                driver.check_draft(config, checkpoint, gates)
            self.assertEqual((config.root / "state.json").read_bytes(), before)
        self.script = [{"artifact": "work before STOP", "draft": validate}]
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "operator_stop")
        self.assertEqual(len(self.captured), 1)

    def test_missing_producer_output_is_not_a_running_dependency(self):
        self.script = [{"decision": "wait", "artifact": "missing output diagnostic"}]
        with self.journal() as (config, journal):
            with self.assertRaisesRegex(ValueError, "unsupported_or_missing_wait_dependency"):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])
            self.assertEqual(self.run_driver(config, journal), "pending_launch_requires_reconciliation")
        self.assertEqual(len(self.captured), 1)

    def test_delivered_input_tampering_rejects_even_successful_child_exit(self):
        def tamper(plan):
            self.write(plan.with_suffix(".stdin.md"), "task without loop fragment")
        self.script = [{"artifact": "result", "decision": "complete", "mutate": tamper}]
        with self.journal() as (config, journal):
            with self.assertRaisesRegex(ValueError, "delivered_input_mismatch"):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])
            self.assertEqual(journal.data["seen_progress"], [])

    def test_goal_loop_entry_validates_seed_without_writes_or_native_queries(self):
        config = self.config()
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        with patch.object(driver, "native", side_effect=AssertionError("unexpected native call")), \
                patch.object(driver, "execute", side_effect=AssertionError("unexpected launch")):
            entry = launch.build_loop_plan(config.filename, config.sha256)
        self.assertEqual(entry["mode"], "goal_loop")
        self.assertEqual(entry["binding"]["session"], SID)
        self.assertEqual(entry["initial_decision"], "continue")
        self.assertEqual(entry["argv"][-5:], ["--config", config.filename,
                         "--config-sha256", config.sha256, "--execute"])
        self.assertEqual({p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}, before)
        self.assertFalse(config.root.exists())

    def test_goal_loop_disabled_config_does_not_launch_or_create_state(self):
        self.config_data["enabled"] = False
        config = self.config()
        with patch.object(driver, "drive", side_effect=AssertionError("unexpected drive")), \
                redirect_stdout(io.StringIO()) as output:
            self.assertEqual(launch.main(["goal-loop", "--config", config.filename,
                             "--config-sha256", config.sha256, "--execute"]), 2)
        self.assertEqual(json.loads(output.getvalue())["reason"], "driver_disabled")
        self.assertFalse(config.root.exists())

    def test_goal_loop_rejects_invalid_seed_without_creating_state(self):
        self.write(self.checkpoint_file, dict(self.checkpoint("continue"), decision="custom_wait"))
        self.config_data["initial_checkpoint"] = driver.file_ref(self.checkpoint_file)
        config = self.config()
        with self.assertRaises(ValueError):
            launch.build_loop_plan(config.filename, config.sha256)
        self.assertFalse(config.root.exists())

    def test_old_bootstrap_contaminated_run_plan_is_not_silently_rewritten(self):
        old = dict(self.plan, prompt_fragment="Bootstrap may create Run. Return Run ID and finish.")
        self.write(self.previous, old)
        self.config_data["previous_plan"] = driver.file_ref(self.previous)
        original = self.previous.read_bytes()
        with self.assertRaisesRegex(ValueError, "launch_plan_or_policy_changed"):
            self.config()
        self.assertEqual(self.previous.read_bytes(), original)
        self.assertFalse(self.captured)

    def test_skill_discovery_includes_hidden_provider_directories_and_roles(self):
        for directory in driver.SKILL_ROOTS:
            self.add_skill("reviewer", directory)
        self.add_skill("paper-scout")
        roles = driver.discover_repository_skills(self.cwd)
        self.assertEqual(set(roles), set(driver.RSI_ROLES))
        self.assertEqual(len(roles["reviewer"]), len(driver.SKILL_ROOTS))
        self.assertEqual(roles["coordinator"], [driver.file_ref(self.skill)])

    def test_skill_discovery_does_not_search_sibling_or_checker_checkout(self):
        sibling = self.checker / ".agents/skills/fin-verl-rsi-reviewer/SKILL.md"
        sibling.parent.mkdir(parents=True)
        self.write(sibling, "not the target skill")
        self.assertNotIn("reviewer", driver.discover_repository_skills(self.cwd))

    def test_missing_coordinator_skill_stops_before_launch(self):
        self.skill.unlink()
        with self.assertRaisesRegex(ValueError, "repository_skills_required"):
            self.config()
        self.assertEqual(self.captured, [])

    def test_omitting_discovered_worker_skill_is_not_silent_fallback(self):
        del self.config_data["repository_skills"]["researcher"]
        with self.assertRaisesRegex(ValueError, "repository_skills_required"):
            self.config()

    def test_skill_from_another_checkout_cannot_replace_repository_skill(self):
        other = self.root / "SKILL.md"
        self.write(other, self.skill.read_text())
        self.config_data["repository_skills"]["coordinator"] = driver.file_ref(other)
        with self.assertRaisesRegex(ValueError, "repository_skill_selection_mismatch"):
            self.config()

    def test_multiple_role_candidates_require_exact_operator_selection(self):
        alternate = self.add_skill("coordinator", ".trae/skills")
        self.write(alternate, "alternative version")
        self.config_data["repository_skills"]["coordinator"] = driver.file_ref(alternate)
        self.assertEqual(self.config().skills["coordinator"], driver.file_ref(alternate))

    def test_skill_change_between_turns_stops_revalidation(self):
        config = self.config()
        self.write(self.skill, "changed after pinning")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            config.revalidate()

    def test_skill_symlink_is_not_followed_into_another_checkout(self):
        other = self.root / "outside-skill.md"
        self.write(other, "other checkout")
        self.skill.unlink()
        self.skill.symlink_to(other)
        with self.assertRaisesRegex(ValueError, "canonical_nonsymlink_path_required"):
            driver.discover_repository_skills(self.cwd)

    def test_discovery_does_not_count_as_read_declaration(self):
        def omit_reads(plan):
            target = plan.parent / "action-accepted.json"
            data = driver.read_json(target)
            data["skills_read"] = []
            self.write(target, data)
        self.script = [{"artifact": "output", "mutate": omit_reads}]
        with self.journal() as (config, journal):
            with self.assertRaisesRegex(ValueError, "repository_skill_read_declaration_mismatch"):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])
            self.assertEqual(journal.data["seen_progress"], [])

    def test_wrong_role_read_cannot_satisfy_coordinator(self):
        def wrong_role(plan):
            target = plan.parent / "action-accepted.json"
            data = driver.read_json(target)
            data["skills_read"] = [driver.file_ref(self.researcher_skill)]
            self.write(target, data)
        self.script = [{"mutate": wrong_role}]
        with self.journal() as (config, journal):
            with self.assertRaisesRegex(ValueError, "repository_skill_read_declaration_mismatch"):
                self.run_driver(config, journal)

    def test_skill_pins_are_handed_off_and_receipted_each_turn(self):
        self.script = [{"artifact": "v1"}, {"artifact": "v2", "decision": "complete"}]
        with self.journal() as (config, journal):
            self.run_driver(config, journal)
            for plan in self.captured:
                text = Path(plan["prompt_file"]).read_text()
                protocol = json.loads(text[text.index("\n{\n") + 1:])
                self.assertEqual(protocol["repository_skills"], {"root": str(self.cwd), "roles": config.skills})
                receipt = driver.read_json(Path(plan["prompt_file"]).parent / "action-receipt.json")
                accepted = driver.parse(driver.pinned(receipt["acceptance"]))
                self.assertEqual(accepted["skills_read"], [driver.file_ref(self.skill)])

    def test_goal_loop_entry_continues_two_real_fixture_children_with_draft_checks(self):
        executable = self.root / "fixture-executable"
        self.write(executable, "#!" + sys.executable + "\nSESSION_LOG = " + repr(str(self.log)) + "\n" + PROCESS_FIXTURE)
        executable.chmod(0o700)
        self.plan = build_trae_plan(trae=str(executable), cwd=self.cwd,
            archive_dir=self.archive, write_dirs=[], selection=driver.SELECTION,
            runtime_config=self.runtime, prompt_file=self.brief, bootstrap_dir=None, resume_session=SID)
        self.write(self.previous, self.plan)
        self.receipts(self.previous, self.start, self.end)
        self.config_data["previous_plan"] = driver.file_ref(self.previous)
        config = self.config()
        forwarded = io.BytesIO()
        console = io.TextIOWrapper(forwarded, encoding="utf-8", write_through=True)
        with self.native_fixture(), redirect_stdout(console):
            self.assertEqual(launch.main(["goal-loop", "--config", config.filename,
                             "--config-sha256", config.sha256, "--execute"]), 0)
        with self.journal(config) as (_, journal):
            self.assertEqual(journal.data["outcome"], "complete_pending_independent_acceptance")
            self.assertEqual(journal.data["attempts"], 2)
            receipts = [driver.read_json(p) for p in config.root.glob("turn-*/launch-plan.process.json")]
            self.assertEqual(len({r["child_pid"] for r in receipts}), 2)
            self.assertTrue(all(r["observed_by"] == "direct-parent-wait-not-signed-attestation" for r in receipts))
        events = [json.loads(line) for line in forwarded.getvalue().splitlines()]
        self.assertEqual([r["type"] for r in events[:-1]], ["thread.started", "operator.child_exited"] * 2)
        self.assertEqual(events[-1]["status"], "complete_pending_independent_acceptance")

    def native_detail(self, cli, runtime, args):
        self.assertEqual(cli, os.environ.get(driver.CLI_ENV))
        self.assertEqual(runtime, "runtime-test")
        if args[:2] == ["terminal", "show"]:
            self.assertEqual(args[2:], ["--terminal", "term_test"])
            return {"terminal": {"handle": "term_test", "incarnationId": "inc_test",
                "worktreeId": "workspace-test", "worktreePath": str(self.cwd),
                "executionHostId": "local", "connected": True, "orphaned": False}}
        if args[:2] == ["worktree", "show"]:
            self.assertEqual(args[2:], ["--worktree", "id:workspace-test"])
            return {"worktree": {"id": "workspace-test", "path": str(self.cwd)}}
        self.assertEqual(args, ["orchestration", "run-current", "--from", "term_test"])
        return {"run": {"id": "run_test"}}

    @contextmanager
    def native_fixture(self):
        def query(args, runtime):
            if args == ["status"]:
                return {"runtime": {"appVersion": "1.4.219", "state": "ready"}}
            self.assertEqual(args, ["orchestration", "run-show", "--id", "run_test"])
            return {"run": copy.deepcopy(self.snapshot["run"])}
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_test",
                                     "ORCA_SERVER_CLI": "/approved/orca-server-cli"}), \
                patch.object(driver.os, "isatty", return_value=True), \
                patch.object(driver.progress_watch, "query", side_effect=query), \
                patch.object(driver, "collect_driver", side_effect=lambda _: copy.deepcopy(self.snapshot)), \
                patch.object(driver, "native", side_effect=self.native_detail):
            yield

    def test_native_fence_uses_only_explicit_read_operations(self):
        with self.native_fixture():
            self.assertEqual(driver.live_fence(self.config()), self.snapshot)

    def test_native_fence_refuses_shell_resume_for_a_strict_run(self):
        with self.native_fixture():
            query = driver.progress_watch.query.side_effect
            def strict_query(args, runtime):
                result = query(args, runtime)
                if args[:2] == ["orchestration", "run-show"]:
                    result["coordinatorPolicy"] = "strict-v1"
                return result
            driver.progress_watch.query.side_effect = strict_query
            with self.assertRaisesRegex(ValueError, "strict_shell_resume_unsupported"):
                driver.live_fence(self.config())

    def test_attention_is_collected_across_pages_without_consuming_inbox(self):
        commands = []
        def query(args, runtime):
            commands.append(args)
            if args == ["status"]:
                return {}
            if args[:2] == ["orchestration", "run-show"]:
                return {"run": self.snapshot["run"]}
            if args[:2] == ["orchestration", "task-list"]:
                return {"runId": "run_test", "count": 0, "tasks": []}
            if args[:2] == ["terminal", "list"]:
                return {"truncated": False, "terminals": []}
            self.assertEqual(args[:2], ["orchestration", "worker-list"])
            second = "--cursor" in args
            return {"scope": {"run": "run_test"},
                "page": {"total": 2, "hasMore": not second, "nextCursor": None if second else "cursor-2"},
                "workers": [{"dispatchId": "second" if second else "first", "projection": {
                    "attention": {"requiresAction": second, "categories": ["question"] if second else []}}}]}
        snapshot = driver.collect_driver(self.config_data["binding"], call=query)
        self.assertTrue(driver.needs_attention(driver.dependency_state(snapshot, ["second"])))
        self.assertFalse(driver.needs_attention(driver.dependency_state(snapshot, ["first"])))
        self.assertFalse(any("check" in args for args in commands))

    def test_generation_owner_incarnation_and_workspace_changes_stop(self):
        config = self.config()
        with self.native_fixture():
            for key, value in (("consumer_generation", 7), ("coordinator_handle", "other"), ("id", "run_other")):
                original = self.snapshot["run"][key]
                self.snapshot["run"][key] = value
                with self.subTest(key=key), self.assertRaisesRegex(ValueError, "run_ownership_changed"):
                    driver.live_fence(config)
                self.snapshot["run"][key] = original
            for key in ("incarnationId", "worktreeId", "worktreePath"):
                def changed(cli, runtime, args):
                    result = self.native_detail(cli, runtime, args)
                    if "terminal" in result:
                        result["terminal"][key] = "wrong"
                    return result
                with self.subTest(key=key), patch.object(driver, "native", side_effect=changed), \
                        self.assertRaisesRegex(ValueError, "terminal_identity_changed"):
                    driver.live_fence(config)

    def test_unknown_owned_workers_count_toward_limit(self):
        self.snapshot["workers"] = [{"dispatch": str(i), "dispatch_status": "failed",
            "resource": "owned", "liveness": "unknown"} for i in range(17)]
        with self.native_fixture(), self.assertRaisesRegex(ValueError, "worker_limit_exceeded"):
            driver.live_fence(self.config())

    def test_driver_refuses_other_terminal_or_nonpty(self):
        with self.native_fixture(), patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "wrong"}), \
                self.assertRaisesRegex(ValueError, "native_pty_required"):
            driver.live_fence(self.config())
        with self.native_fixture(), patch.object(driver.os, "isatty", return_value=False), \
                self.assertRaisesRegex(ValueError, "native_pty_output_required"):
            driver.live_fence(self.config())

    def test_plans_only_stops_and_restart_does_not_reset(self):
        self.script = [{}, {}]
        config = self.config()
        with self.journal(config) as (_, journal):
            self.assertEqual(self.run_driver(config, journal), "no_progress_recovery_exhausted")
            self.assertEqual(driver.read_json(journal.data["current"]["checkpoint"]["path"])["decision"], "continue")
            self.assertEqual(journal.data["no_progress_turns"], 2)
        with self.journal(config) as (_, journal):
            self.assertEqual(self.run_driver(config, journal), "no_progress_recovery_exhausted")
        self.assertEqual(len(self.captured), 2)

    def test_lifecycle_binds_input_action_executor_and_next_checkpoint(self):
        self.script = [{"artifact": "v1"}, {"artifact": "v2", "decision": "complete"}]
        with self.journal() as (config, journal):
            self.run_driver(config, journal)
            receipts = [driver.read_json(p) for p in sorted(config.root.glob("turn-*/action-receipt.json"))]
            self.assertEqual(receipts[0]["action"]["incoming_checkpoint"], config.data["initial_checkpoint"])
            self.assertEqual(receipts[1]["action"]["incoming_checkpoint"], receipts[0]["checkpoint"])
            self.assertNotEqual(receipts[0]["action"], receipts[1]["action"])
            for r in receipts:
                self.assertEqual(r["execution_status"], "result_verified")
                self.assertEqual(r["action"]["binding"], config.data["binding"])
                self.assertEqual(r["action"]["executor"], "coordinator")
                self.assertTrue(r["check"]["authority_declarations_evaluated"])
            events = [json.loads(v)["event"] for v in (config.root / "events.jsonl").read_text().splitlines()]
            for event in ("launch_intent", "action_accepted", "action_started", "action_result_verified"):
                self.assertEqual(events.count(event), 2)

    def test_unsupported_owner_stops_without_executing_as_coordinator(self):
        record = self.checkpoint("continue", self.start + timedelta(seconds=1))
        record["next_action"]["owner"] = "unsupported-executor"
        self.initial(record)
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "unsupported_action_owner")
            self.assertEqual(journal.data["attempts"], 0)
            self.assertEqual(driver.read_json(journal.data["current"]["checkpoint"]["path"])["decision"], "continue")
            self.assertEqual(journal.data["operator_requests"], {})
            self.assertIn('"event":"execution_stalled"', (config.root / "events.jsonl").read_text())
        self.assertFalse(self.captured)

    def test_next_outer_operator_action_hands_off_after_settling_current_action(self):
        record = self.checkpoint("continue")
        record["next_action"]["owner"] = "outer-operator"
        self.script = [{"artifact": "inventory", "record": record}]
        with self.journal() as (config, journal):
            def stop_after_handoff(_):
                self.assertIsNone(journal.data["outcome"])
                self.assertIsNone(journal.data["pending"])
                self.assertEqual(journal.data["attempts"], 1)
                self.assertEqual(len(journal.data["operator_requests"]), 1)
                self.write(config.root / "STOP", "fixture stop after observing request")
            self.assertEqual(self.run_driver(config, journal, sleep=stop_after_handoff), "operator_stop")
            self.assertIsNone(journal.data["pending"])
        self.assertEqual(len(self.captured), 1)

    def test_no_progress_cannot_replace_the_unexecuted_action_with_another_plan(self):
        record = self.checkpoint("continue")
        record["next_action"]["id"] = "finalize-delivery"
        self.script = [{"record": record}]
        with self.journal() as (config, journal):
            with self.assertRaisesRegex(ValueError, "action_advanced_without_execution"):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])

    def test_settled_action_result_revalidated_before_next_launch(self):
        self.script = [{"artifact": "v1", "mutate": lambda p: self.write(p.parent.parent / "STOP", "stop")}]
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "operator_stop")
            result = config.root / "turn-000001/action-result.json"
            self.write(result, {})
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                driver.current_evidence(config, journal.data["current"])

    def test_authority_documents_and_skills_are_not_progress_artifacts(self):
        # A deliberately broad task root still cannot turn control data into progress.
        self.plan = build_trae_plan(trae=sys.executable, cwd=self.cwd,
            archive_dir=self.archive, write_dirs=[str(self.root)], selection=driver.SELECTION,
            runtime_config=self.runtime, prompt_file=self.brief, bootstrap_dir=None, resume_session=SID)
        self.write(self.previous, self.plan)
        self.config_data["previous_plan"] = driver.file_ref(self.previous)
        self.config_data["progress_roots"] = [str(self.root)]
        config = self.config()
        action = driver.obligation(config, config.data["initial_checkpoint"], self.checkpoint("continue"), 1)
        result = self.root / "result.json"
        for target in (self.ledger_file, self.catalog_file, self.handoff_file, self.gates_file,
                       self.checker / "rsi/authority.py", self.skill, self.researcher_skill,
                       self.previous.with_suffix(".stdin.md")):
            with self.subTest(target=str(target)):
                self.write(result, {"schema_version": 2, "action": action, "status": "executed",
                    "waiting_dispatches": [], "artifacts": [dict(driver.file_ref(target), kind="source")]})
                with self.assertRaisesRegex(ValueError, "progress_artifact_outside_scope"):
                    driver.action_result(config, result, action, {"tool_fingerprints": ["proof"]})

    def test_legacy_config_is_rejected_without_silent_upgrade(self):
        for version in (1, 2, 3, 4):
            with self.subTest(version=version):
                self.config_data["schema_version"] = version
                with self.assertRaisesRegex(ValueError, "invalid_driver_config"):
                    self.config()
        self.assertFalse((self.archive / "coordinator-driver").exists())

    def test_terminal_plans_only_cannot_bypass_execution_gate(self):
        for decision in ("complete", "blocked"):
            with self.subTest(decision=decision):
                fixture = DriverTests()
                fixture.setUp()
                try:
                    fixture.script = [{"decision": decision}]
                    with fixture.journal() as (config, journal):
                        with self.assertRaisesRegex(ValueError, "remaining_path_disappeared|terminal_claim_without_execution"):
                            fixture.run_driver(config, journal)
                        self.assertIsNotNone(journal.data["pending"])
                        self.assertEqual(driver.read_json(journal.data["current"]["checkpoint"]["path"])["decision"], "continue")
                finally:
                    fixture.doCleanups()

    def test_unrelated_task_completions_never_reset_no_progress(self):
        def unrelated(plan):
            self.snapshot["tasks"].append({"id": str(len(self.captured)), "status": "completed"})
        self.script = [{"mutate": unrelated}, {"mutate": unrelated}]
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "no_progress_recovery_exhausted")
            self.assertEqual(journal.data["no_progress_turns"], 2)

    def test_action_binding_replay_or_absent_acceptance_stops_before_next_turn(self):
        def mutate(plan):
            result = driver.read_json(plan.parent / "action-result.json")
            result["action"]["incoming_checkpoint"]["sha256"] = "0" * 64
            self.write(plan.parent / "action-result.json", result)
        self.script = [{"artifact": "output", "mutate": mutate}]
        with self.journal() as (config, journal):
            with self.assertRaisesRegex(ValueError, "action_result_mismatch"):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])
        self.assertEqual(len(self.captured), 1)

    def test_missing_acceptance_is_not_inferred_from_clean_process_exit(self):
        self.script = [{"artifact": "output", "mutate": lambda p: (p.parent / "action-accepted.json").unlink()}]
        with self.journal() as (config, journal):
            with self.assertRaises(FileNotFoundError):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])

    def test_acceptance_cannot_be_reused_from_earlier_turn(self):
        def mutate(plan):
            target = plan.parent / "action-accepted.json"
            value = driver.read_json(target)
            value["accepted_at"] = self.start.isoformat()
            self.write(target, value)
        self.script = [{"artifact": "output", "mutate": mutate}]
        with self.journal() as (config, journal):
            with self.assertRaisesRegex(ValueError, "action_acceptance_outside_turn"):
                self.run_driver(config, journal)

    def add_independent_path(self, record):
        route = dict(record["paths"][0], id="independent", operation="inventory independent source")
        record["paths"].append(route)
        catalog = driver.read_json(self.catalog_file)
        catalog["paths"].append({"id": route["id"], "operation": route["operation"], "permissions": ["research"]})
        self.write(self.catalog_file, catalog)
        self.config_data["authority"]["path_catalog"] = self.json_ref(self.catalog_file)
        return record

    def test_one_blocked_path_does_not_prevent_independent_iteration(self):
        initial = self.add_independent_path(self.checkpoint("continue", self.start + timedelta(seconds=1)))
        self.initial(initial)
        after = copy.deepcopy(initial)
        blocked = self.checkpoint("blocked")
        after["paths"][0] = blocked["paths"][0]
        after["barriers"] = blocked["barriers"]
        after["next_action"].update(id="inventory", path_ids=["independent"])
        self.script = [{"artifact": "barrier evidence", "record": after},
                       {"artifact": "independent inventory", "record": after}, {}, {}]
        # Stop at the second successful action without pretending business completion.
        def stop(plan):
            self.write(plan.parent.parent / "STOP", "fixture reached inventory")
        self.script[1]["mutate"] = stop
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "operator_stop")
            self.assertEqual(journal.data["attempts"], 2)
        text = Path(self.captured[1]["prompt_file"]).read_text()
        self.assertEqual(json.loads(text[text.index("\n{\n") + 1:])["action"]["action_id"], "inventory")

    def test_completed_target_can_retire_without_dropping_other_paths(self):
        initial = self.add_independent_path(self.checkpoint("continue", self.start + timedelta(seconds=1)))
        self.initial(initial)
        after = copy.deepcopy(initial)
        after["paths"] = after["paths"][1:]
        after["next_action"].update(id="inventory", path_ids=["independent"])
        self.script = [{"artifact": "first action evidence", "record": after},
                       {"artifact": "second action evidence", "decision": "complete"}]
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "complete_pending_independent_acceptance")

    def test_independent_path_cannot_silently_disappear_or_be_blocked(self):
        initial = self.add_independent_path(self.checkpoint("continue", self.start + timedelta(seconds=1)))
        self.initial(initial)
        after = self.checkpoint("continue")  # Omits independent, unmet work.
        self.script = [{"artifact": "archive report", "record": after}]
        with self.journal() as (config, journal):
            with self.assertRaisesRegex(ValueError, "remaining_path_disappeared"):
                self.run_driver(config, journal)
        blocked = copy.deepcopy(initial)
        blocked["paths"][1]["status"] = "blocked"
        with self.assertRaisesRegex(ValueError, "independent_path_silently_blocked"):
            driver.transition(initial, blocked, {"status": "executed"}, {"proof"})

    def test_full_authority_checker_missing_is_not_downgraded_to_base_checker(self):
        (self.checker / "rsi/authority.py").unlink()
        self.config_data["checker"]["files"] = self.manifest()
        with self.assertRaisesRegex(ValueError, "full_authority_checker_required"):
            self.config()

    def test_handoff_cannot_rewrite_original_permission_or_judge(self):
        handoff = driver.read_json(self.handoff_file)
        for field, value in (("permissions.local_edit", "denied"), ("models.judge", "different-model")):
            with self.subTest(field=field):
                changed = copy.deepcopy(handoff)
                changed["fields"][field] = value
                self.write(self.handoff_file, changed)
                self.config_data["authority"]["handoff"] = self.json_ref(self.handoff_file)
                config = self.config()
                with self.assertRaisesRegex(ValueError, "checkpoint_validation_failed"):
                    driver.check_checkpoint(config, config.data["initial_checkpoint"],
                                            driver.read_json(self.previous.with_suffix(".process.json")))

    def test_unreviewed_path_and_changed_user_source_stop(self):
        config = self.config()
        record = self.checkpoint("continue")
        record["paths"][0]["operation"] = "submit expensive training"
        with self.assertRaisesRegex(ValueError, "unreviewed_authority_path"):
            driver.authority_inputs(config, record)
        # Even updating the brief pin cannot rewrite the original ledger source pin.
        self.write(self.brief, "Original authorized task changed")
        self.config_data["brief"] = driver.file_ref(self.brief)
        with self.assertRaisesRegex(ValueError, "launch_plan_or_policy_changed"):
            self.config()  # The new input pin detects this even before authority replay.

    def test_limits_cannot_exceed_replayed_authority(self):
        self.config_data["limits"]["max_workers"] = 17
        with self.assertRaisesRegex(ValueError, "authority_limit_mismatch"):
            self.config()

    def test_false_ready_platform_gate_does_not_launch(self):
        gates = driver.read_json(self.gates_file)
        gates["paths"][0]["platform"] = "denied"
        self.write(self.gates_file, gates)
        self.config_data["initial_gates"] = driver.file_ref(self.gates_file)
        with self.journal() as (config, journal):
            with self.assertRaisesRegex(ValueError, "checkpoint_validation_failed"):
                self.run_driver(config, journal)
        self.assertFalse(self.captured)

    def test_renaming_identical_artifact_does_not_reset(self):
        self.script = [{"artifact": "same"}, {"artifact": "same", "filename": "renamed.py"}, {"artifact": "same"}]
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "no_progress_recovery_exhausted")
            self.assertEqual(journal.data["attempts"], 3)

    def test_repeating_analysis_does_not_reset_no_progress_counter(self):
        self.script = [{"artifact": "same completed design", "artifact_kind": "analysis", "filename": filename}
                       for filename in ("design.md", "renamed-design.md", "design.md")]
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "no_progress_recovery_exhausted")
            self.assertEqual(journal.data["attempts"], 3)
            self.assertEqual(journal.data["no_progress_turns"], 2)

    def test_artifact_without_actual_tool_execution_is_not_progress(self):
        self.script = [{"artifact": "a", "tool": False}, {"artifact": "b", "tool": False}]
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal), "no_progress_recovery_exhausted")

    def test_pending_launch_never_replays(self):
        config = self.config()
        with self.journal(config) as (_, journal):
            journal.data["attempts"] = 1
            journal.data["pending"] = {"attempt": 1}
            journal.save()
        with self.journal(config) as (_, journal):
            self.assertEqual(self.run_driver(config, journal), "pending_launch_requires_reconciliation")
        self.assertEqual(self.captured, [])

    def interrupt_prepared_settlement(self, config, step=None):
        self.script = [step or {"artifact": "verified output", "decision": "complete"}]
        with self.journal(config) as (_, journal):
            with patch.object(driver, "settle_prepared", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])
            self.assertEqual(journal.data["no_progress_turns"], 0)
            self.assertEqual(journal.data["seen_progress"], [])

    def test_prepared_settlement_recovers_without_reexecuting(self):
        config = self.config()
        self.interrupt_prepared_settlement(config)
        with self.journal(config) as (_, journal):
            self.assertEqual(self.run_driver(config, journal), "complete_pending_independent_acceptance")
            self.assertIsNone(journal.data["pending"])
            self.assertEqual(journal.data["attempts"], 1)
        with self.journal(config) as (_, journal):
            self.assertEqual(self.run_driver(config, journal), "complete_pending_independent_acceptance")
        self.assertEqual(len(self.captured), 1)

    def test_prepared_settlement_preserves_no_progress_count(self):
        config = self.config()
        self.interrupt_prepared_settlement(config, {"status": "no_progress"})
        self.script = [{"status": "no_progress"}]
        with self.journal(config) as (_, journal):
            self.assertEqual(self.run_driver(config, journal), "no_progress_recovery_exhausted")
            self.assertEqual(journal.data["no_progress_turns"], 2)
        self.assertEqual(len(self.captured), 2)

    def test_prepared_settlement_cannot_clear_stop_or_outcome(self):
        config = self.config()
        self.interrupt_prepared_settlement(config)
        with self.journal(config) as (_, journal):
            journal.stop("explicit_stop")
        with self.journal(config) as (_, journal):
            self.assertEqual(self.run_driver(config, journal), "explicit_stop")
            self.assertIsNotNone(journal.data["pending"])
        self.assertEqual(len(self.captured), 1)

    def test_prepared_settlement_rechecks_exit_and_artifacts(self):
        config = self.config()
        self.interrupt_prepared_settlement(config)
        self.write(self.cwd / "result.py", "changed output")
        with self.journal(config) as (_, journal):
            with self.assertRaises(ValueError):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])
        self.assertEqual(len(self.captured), 1)

    def test_prepared_settlement_rejects_changed_before_state(self):
        config = self.config()
        self.interrupt_prepared_settlement(config)
        with self.journal(config) as (_, journal):
            journal.data["no_progress_turns"] = 1
            journal.save()
        with self.journal(config) as (_, journal):
            with self.assertRaisesRegex(ValueError, "settlement_state_changed"):
                self.run_driver(config, journal)

    def test_prepared_settlement_rechecks_native_identity(self):
        config = self.config()
        self.interrupt_prepared_settlement(config)
        with self.journal(config) as (_, journal):
            with self.assertRaisesRegex(ValueError, "runtime_access_denied"):
                driver.drive(config, journal, capture=self.capture,
                             fence=lambda _: (_ for _ in ()).throw(ValueError("runtime_access_denied")))
            self.assertIsNotNone(journal.data["pending"])
        self.assertEqual(len(self.captured), 1)

    def test_exclusive_lock_rejects_second_driver(self):
        with self.journal() as (config, _):
            with self.assertRaises(BlockingIOError), driver.Journal(config.root, config.sha256).locked():
                self.fail("second lock acquired")

    def test_incomplete_atomic_state_requires_reconciliation(self):
        config = self.config()
        with self.journal(config) as (_, journal):
            self.write(config.root / "state.next.json", {})
        with self.assertRaisesRegex(ValueError, "unreconciled_state_write"), self.journal(config):
            pass

    def test_corrupt_state_counters_rejected(self):
        config = self.config()
        with self.journal(config) as (_, journal):
            journal.data["attempts"] = True
            journal.save()
        with self.assertRaisesRegex(ValueError, "invalid_driver_counter"), self.journal(config):
            pass

    def test_unknown_capture_crash_never_replays_after_process_restart(self):
        config = self.config()
        with self.journal(config) as (_, journal):
            with self.assertRaises(KeyboardInterrupt):
                driver.drive(config, journal, capture=lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()),
                             fence=lambda _: copy.deepcopy(self.snapshot), output=io.BytesIO())
        with self.journal(config) as (_, journal):
            self.assertEqual(self.run_driver(config, journal), "pending_launch_requires_reconciliation")
        self.assertFalse(self.captured)

    def test_denial_in_structured_error_stops_but_prose_does_not(self):
        stream_file = self.previous.with_suffix(".stdout.jsonl")
        events = [json.loads(line) for line in stream_file.read_text().splitlines()]
        events[1]["item"]["aggregated_output"] = "test verifies permission_denied stops retry"
        self.write(stream_file, "".join(json.dumps(e) + "\n" for e in events))
        driver.finished(driver.file_ref(self.previous), SID)
        events[1]["item"]["error"] = {"code": "permission_denied"}
        self.write(stream_file, "".join(json.dumps(e) + "\n" for e in events))
        with self.assertRaisesRegex(ValueError, "execution_permission_denied"):
            driver.finished(driver.file_ref(self.previous), SID)

    def test_out_of_scope_and_symlink_progress_rejected(self):
        config = self.config()
        external = self.root / "outside.py"
        self.write(external, "not in task")
        result = self.root / "result.json"
        action = driver.obligation(config, config.data["initial_checkpoint"], self.checkpoint("continue"), 1)
        payload = {"schema_version": 2, "action": action, "status": "executed", "waiting_dispatches": [],
                   "artifacts": [dict(driver.file_ref(external), kind="source")]}
        self.write(result, payload)
        with self.assertRaisesRegex(ValueError, "progress_artifact_outside_scope"):
            driver.action_result(config, result, action, {"tool_fingerprints": ["proof"]})
        link = self.cwd / "symlink.py"
        link.symlink_to(external)
        payload["artifacts"][0]["path"] = str(link)
        self.write(result, payload)
        with self.assertRaisesRegex(ValueError, "nonsymlink"):
            driver.action_result(config, result, action, {"tool_fingerprints": ["proof"]})

    def test_clean_exit_required(self):
        original = driver.read_json(self.previous.with_suffix(".process.json"))
        for changes in ({"exit_code": None}, {"exit_code": 1}, {"exit_code": False},
                        {"observed_by": "pid_absent"}, {"stream_errors": ["invalid"]},
                        {"resume_session": "other"}):
            with self.subTest(changes=changes):
                self.write(self.previous.with_suffix(".process.json"), dict(original, **changes))
                with self.assertRaises(ValueError):
                    driver.finished(driver.file_ref(self.previous), SID)

    def test_stream_identity_and_completion_required(self):
        stream_file = self.previous.with_suffix(".stdout.jsonl")
        valid = stream_file.read_text()
        variants = [valid[:-1], valid.splitlines()[0] + "\n", valid.replace(SID, "wrong"),
                    valid + valid, valid.replace('"turn.completed"', '"turn.failed"')]
        for content in variants:
            with self.subTest(content=content):
                self.write(stream_file, content)
                with self.assertRaises(ValueError):
                    driver.finished(driver.file_ref(self.previous), SID)

    def test_nonzero_capture_preserves_pending(self):
        self.script = [{"code": 9}]
        with self.journal() as (config, journal):
            with self.assertRaisesRegex(ValueError, "continuation_capture_failed"):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])
            self.assertEqual(journal.data["attempts"], 1)

    def test_invalid_new_checkpoint_does_not_loop(self):
        self.script = [{"mutate": lambda p: self.write(p.parent / "checkpoint.json", {})}]
        with self.journal() as (config, journal):
            with self.assertRaises((ValueError, KeyError)):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])
        self.assertEqual(len(self.captured), 1)

    def test_actual_extra_write_roots_cannot_silently_expand_between_turns(self):
        def widen(_):
            events = [json.loads(line) for line in self.log.read_text().splitlines()]
            events[-1]["payload"]["sandbox_policy"]["writable_roots"].append(str(self.root))
            self.write(self.log, "".join(json.dumps(e) + "\n" for e in events))
        self.script = [{"mutate": widen}]
        with self.journal() as (config, journal):
            with self.assertRaisesRegex(ValueError, "effective_policy_changed"):
                self.run_driver(config, journal)
            self.assertIsNotNone(journal.data["pending"])

    def test_last_prelaunch_fence_failure_does_not_start_child(self):
        calls = []
        def fence(_):
            calls.append(True)
            if len(calls) == 3:
                raise driver.progress_watch.StopObservation("runtime_access_denied")
            return copy.deepcopy(self.snapshot)
        with self.journal() as (config, journal):
            with self.assertRaisesRegex(driver.progress_watch.StopObservation, "runtime_access_denied"):
                driver.drive(config, journal, capture=self.capture, fence=fence, output=io.BytesIO())
            self.assertIsNotNone(journal.data["pending"])
        self.assertFalse(self.captured)

    def test_checkpoint_and_context_must_belong_to_actual_turn(self):
        config = self.config()
        record = driver.read_json(self.checkpoint_file)
        record["observed_at"] = (self.start - timedelta(seconds=1)).isoformat()
        self.write(self.checkpoint_file, record)
        receipt = driver.read_json(self.previous.with_suffix(".process.json"))
        with self.assertRaisesRegex(ValueError, "checkpoint_outside_turn"):
            driver.check_checkpoint(config, driver.file_ref(self.checkpoint_file), receipt)
        self.session_log(self.start - timedelta(seconds=1))
        with self.assertRaisesRegex(ValueError, "stale"):
            driver.effective(config, receipt)

    def test_pin_changes_stop(self):
        for field in ("brief", "contract", "initial_checkpoint", "previous_plan"):
            config = self.config()
            target = Path(config.data[field]["path"])
            original = target.read_bytes()
            target.write_bytes(original + b" ")
            try:
                if field == "contract":
                    # Contract intentionally pins canonical JSON, not pretty-printing.
                    config.revalidate()
                    self.write(target, dict(self.contract, objective_ref="changed"))
                with self.subTest(field=field), self.assertRaises(ValueError):
                    config.revalidate()
            finally:
                target.write_bytes(original)

    def test_checker_code_and_file_set_are_pinned(self):
        config = self.config()
        self.write(self.checker / "rsi/extra.py", "")
        with self.assertRaisesRegex(ValueError, "checker_file_set_changed"):
            config.revalidate()

    def test_checker_uses_verified_bytes_not_disk_imports(self):
        config = self.config()
        spec = config.data["checker"]
        original = driver.checker_sources(spec)
        self.write(self.checker / "rsi/progress.py", "raise RuntimeError('untrusted disk import')")
        receipt = driver.read_json(self.previous.with_suffix(".process.json"))
        with patch.object(driver, "checker_sources", return_value=original):
            record, checked = driver.check_checkpoint(config, config.data["initial_checkpoint"], receipt)
        self.assertEqual(record["decision"], "continue")
        self.assertTrue(checked["consistent"])

    def test_changed_config_cannot_reset_state(self):
        config = self.config()
        with self.journal(config):
            pass
        self.config_data["limits"]["max_no_progress_turns"] = 3
        with self.assertRaisesRegex(ValueError, "driver_config_changed"), self.journal(self.config()):
            pass

    def test_launch_policy_changes_rejected(self):
        changed = dict(self.plan, argv=["/bin/true"])
        self.write(self.previous, changed)
        self.config_data["previous_plan"] = driver.file_ref(self.previous)
        with self.assertRaisesRegex(ValueError, "launch_plan_or_policy_changed"):
            self.config()

    def test_wait_unchanged_does_not_launch_and_change_resumes(self):
        self.snapshot["workers"] = [{"dispatch": "dispatch_fixture", "task": "task_fixture",
            "state": "running", "dispatch_status": "running", "resource": "owned",
            "release": None, "liveness": "live"}]
        self.script = [{"decision": "wait", "waiting_dispatches": ["dispatch_fixture"]},
                       {"decision": "complete", "artifact": "after dependency"}]
        sleeps = []
        def wait(seconds):
            sleeps.append(seconds)
            self.assertEqual(len(self.captured), 1)
            if len(sleeps) == 2:
                self.snapshot["workers"][0]["dispatch_status"] = "completed"
                self.snapshot["workers"][0]["liveness"] = "exited"
        with self.journal() as (config, journal):
            self.assertEqual(self.run_driver(config, journal, sleep=wait), "complete_pending_independent_acceptance")
        self.assertEqual(sleeps, [1, 1])
        self.assertEqual(len(self.captured), 2)
        self.assertTrue(all(plan["resume_session"] == SID for plan in self.captured))

    def test_already_settled_wait_or_pending_question_wakes_without_waiting(self):
        for status, action in (("completed", False), ("running", True)):
            with self.subTest(status=status):
                fixture = DriverTests()
                fixture.setUp()
                try:
                    fixture.snapshot["workers"] = [{"dispatch": "dep", "dispatch_status": status,
                        "liveness": "unknown", "attention": {"requires_action": action}}]
                    fixture.initial(fixture.checkpoint("wait", fixture.start + timedelta(seconds=1)))
                    fixture.config_data["initial_waiting_dispatches"] = ["dep"]
                    fixture.script = [{"decision": "complete", "artifact": "answer"}]
                    with fixture.journal() as (config, journal):
                        self.assertEqual(fixture.run_driver(config, journal,
                            sleep=lambda _: self.fail("settled/question dependency must not sleep")),
                            "complete_pending_independent_acceptance")
                finally:
                    fixture.doCleanups()

    def test_external_or_missing_wait_dependency_stops(self):
        for deps in ([], ["unknown_dispatch"]):
            with self.subTest(deps=deps), self.assertRaises(ValueError):
                driver.dependency_state(self.snapshot, deps)

    def test_unknown_worker_is_not_zero(self):
        self.snapshot["workers"] = [{"dispatch": "unknown", "liveness": "unknown", "resource": "owned"}]
        self.assertEqual(driver.dependency_state(self.snapshot, ["unknown"])[0]["liveness"], "unknown")

    def test_blocked_and_complete_never_start(self):
        for decision, outcome in (("blocked", "blocked_pending_independent_alternatives_review"), ("complete", "complete_pending_independent_acceptance")):
            with self.subTest(decision=decision):
                # Use a distinct temporary fixture per terminal case, not a reset of a Run.
                fixture = DriverTests()
                fixture.setUp()
                try:
                    fixture.initial(fixture.checkpoint(decision, fixture.start + timedelta(seconds=1)))
                    with fixture.journal() as (config, journal):
                        self.assertEqual(fixture.run_driver(config, journal), outcome)
                    self.assertEqual(fixture.captured, [])
                finally:
                    fixture.doCleanups()

    def test_stop_sentinel_never_starts_next_turn(self):
        with self.journal() as (config, journal):
            self.write(config.root / "STOP", "operator request")
            self.assertEqual(self.run_driver(config, journal), "operator_stop")
        self.assertFalse(self.captured)

    def test_permission_denial_is_latched_without_retry(self):
        config = self.config()
        with patch.object(driver, "live_fence", side_effect=driver.progress_watch.StopObservation("runtime_access_denied")):
            # drive's default is bound at definition; patch the boundary explicitly.
            with patch.object(driver, "drive", side_effect=driver.progress_watch.StopObservation("runtime_access_denied")):
                with self.assertRaisesRegex(ValueError, "runtime_access_denied"):
                    driver.execute(config)
        state = driver.read_json(config.root / "state.json")
        self.assertEqual(state["outcome"], "runtime_access_denied")
        self.assertEqual(state["attempts"], 0)

    def test_cli_default_is_offline_and_disabled_execution_rejected(self):
        self.config_data["enabled"] = False
        config = self.config()
        with patch.object(driver, "live_fence", side_effect=AssertionError("native query")), redirect_stdout(io.StringIO()) as out:
            self.assertEqual(driver.main(["--config", config.filename, "--config-sha256", config.sha256]), 0)
        self.assertIn("no_launch_or_native_query", out.getvalue())
        self.assertFalse(config.root.exists())
        with self.assertRaisesRegex(ValueError, "driver_disabled"):
            driver.execute(config)


if __name__ == "__main__":
    unittest.main()
