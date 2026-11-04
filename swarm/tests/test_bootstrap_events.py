"""Phase-1 offline evidence diagnostics; no live runtime or bootstrap executor."""

import copy
from contextlib import redirect_stdout
from datetime import timedelta
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from bootstrap_events import EvidenceReader, check_state
from bootstrap_protocol import BACKEND, EVENTS, PRODUCERS, layout, review_route
from coordinator_io import canonical, file_ref, parse, pinned, timestamp
from coordinator_launch import main
from coordinator_request_prepare import exact_refs, source_contract
import test_coordinator_strict_request as request_tests


class BootstrapEventsTests(unittest.TestCase):
    def setUp(self):
        self.base = request_tests.StrictRequestTests()
        self.base.setUp()
        self.addCleanup(self.base.doCleanups)
        self.root = self.base.root
        self.paths = layout(self.root)
        self.clock = self.base.clock + timedelta(seconds=10)
        self.at = self.base.clock.isoformat()
        self.caller = self.put("caller_receipt", self.base.tui.caller)
        observation = copy.deepcopy(self.base.observation)
        observation["caller_receipt"] = self.caller
        self.observation = self.put("session_observation", observation)
        fields = parse(pinned(self.base.source["contract_fields"]))
        fields["observation"].update(caller_receipt=self.caller, startup_anchor=self.observation)
        fields["skill_read_evidence"] = self.put("skill_read_evidence", {"read": "fixture"})
        self.fields = self.put("contract_fields", fields)
        probe = self.root / "coordinator" / "file-tool-probe.json"
        probe.write_bytes(canonical({"probe": "fixture"}))
        self.probe = file_ref(probe)
        self.b = dict(schema_version=1, kind="strict_bootstrap_binding", attempt_id="attempt-test",
            runtime=self.base.source["runtime"], workspace=self.base.source["workspace"],
            coordinator=dict(terminal="term_test", incarnation="inc_test", process_incarnation="pty:inc_test",
                             pane_key="tab:leaf", agent="trae"), operator=fields["operator"], paths=self.paths,
            created_at=(timestamp(self.base.tui.caller["checkedAt"]) - timedelta(seconds=1)).isoformat(),
            deadline=(self.clock + timedelta(minutes=10)).isoformat(), context_max_age_seconds=1800,
            fixed_inputs={k: fields[k] for k in ("cli", "runtime_config", "role_skill", "handoff", "skill_read_evidence")},
            authorization_refs=parse(pinned(self.base.source["task_source"]))["authorization_refs"],
            file_tool_evidence_paths=[str(probe)],
            control=dict(backend=BACKEND, control_id="control-test", generation="generation-1"),
            execution_authorized=False)
        self.bind()
        self.base.tui.calls.clear()

    def put(self, slot, value):
        p = Path(self.paths[slot])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(canonical(value) + b"\n")
        return file_ref(p)

    def bind(self):
        p = self.root / "attempt-binding.json"
        p.write_bytes(canonical(self.b) + b"\n")
        self.binding = file_ref(p)

    def review(self, stage, upstream, subjects, evidence):
        request = self.put(stage + "_review_request", dict(schema_version=1,
            kind="strict_bootstrap_review_request", request_id="attempt-test:" + stage,
            attempt_binding=self.binding, stage=stage, upstream=upstream, subject_refs=subjects,
            evidence_refs=evidence, operator=self.b["operator"], result_path=self.paths[stage + "_review"],
            created_at=self.at, deadline=self.b["deadline"], execution_authorized=False))
        return self.put(stage + "_review", dict(schema_version=1, kind="strict_bootstrap_review_result",
            request=request, subject_refs=subjects, evidence_refs=evidence, operator=self.b["operator"],
            decision="approve", notes="Offline fixture, not a real review", reviewed_at=self.at,
            identity_verified=False, execution_authorized=False))

    def chain(self, count=4):
        refs = []
        for index, event in enumerate(EVENTS[:count]):
            marker = dict(schema_version=1, kind="strict_bootstrap_event", event=event,
                attempt_id="attempt-test", sequence=index + 1, attempt_binding=self.binding,
                created_at=self.at, producer=PRODUCERS[index], execution_authorized=False)
            if index:
                marker["consumes"] = dict(refs[-1], event=EVENTS[index - 1])
            if index < 2:
                marker.update(runtime=self.b["runtime"], workspace=self.b["workspace"], caller_receipt=self.caller)
            if index == 0:
                marker.update(coordinator={k: self.b["coordinator"][k] for k in ("terminal", "incarnation", "agent")},
                    context=dict(context_max_age_seconds=1800, requires_live_caller_check=True))
            elif index == 1:
                marker.update(coordinator=parse(pinned(self.fields))["coordinator"], session_observation=self.observation,
                    trust_boundary="runtime-state-and-log-not-live-process-attested", requires_live_caller_check=True)
            elif index == 2:
                marker.update(contract_fields=self.fields,
                    review_receipt=self.review("contract", refs[-1], [self.fields],
                        [self.caller, self.observation, self.b["fixed_inputs"]["skill_read_evidence"]]),
                    must_match=dict(runtime=self.b["runtime"], workspace_id=self.b["workspace"]["id"],
                                    coordinator_terminal="term_test"))
            else:
                evidence = [self.b["fixed_inputs"]["skill_read_evidence"], self.probe]
                manifest = self.put("final_readiness", dict(schema_version=1, kind="strict_bootstrap_readiness",
                    attempt_binding=self.binding, contract_fields=self.fields, evidence=evidence,
                    created_at=self.at, execution_authorized=False))
                review = self.review("readiness", refs[-1], [manifest], evidence)
                marker.update(readiness_evidence=[*evidence, manifest, review],
                    evidence_roles=[dict(ref=evidence[0], role="skill"), dict(ref=evidence[1], role="file-tool")],
                    required_refs=dict(skill_read_evidence_present=True, file_tool_probe_evidence_present=True))
            refs.append(self.put(event, marker))
        return refs

    def check(self, **extra):
        args = dict(attempt_binding_sha256=self.binding["sha256"], expect_attempt="attempt-test", clock=self.clock)
        args.update(extra)
        with patch("subprocess.Popen", side_effect=AssertionError("no processes allowed")):
            result = check_state(str(self.root), **args)
        self.assertFalse(result["ready"])
        self.assertFalse(result["execution_authorized"])
        self.assertTrue(result["diagnostic_only"])
        self.assertIsNone(result["last_committed_stage"])
        self.assertEqual(self.base.tui.calls, [])
        return result

    def edit(self, slot, **values):
        value = parse(pinned(file_ref(self.paths[slot])))
        value.update(values)
        return self.put(slot, value)

    def test_complete_chain_is_read_only_unverified_and_pins_compatible(self):
        self.chain()
        before = {str(p): (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.rglob("*") if p.is_file()}
        result = self.check()
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["evidence_chain_complete"])
        self.assertEqual(result["state"], "durability_unverified")
        preview = result["request_input_preview"]
        self.assertEqual(exact_refs(preview["readiness_evidence"]), preview["readiness_evidence"])
        source_contract(dict(preview, cli=self.b["fixed_inputs"]["cli"], runtime=self.b["runtime"],
                             workspace=self.b["workspace"], coordinator=parse(pinned(self.fields))["coordinator"]))
        after = {str(p): (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertFalse(Path(self.paths["request"]).exists())

    def test_each_missing_next_stage_is_pending_not_ready(self):
        for count in range(4):
            with self.subTest(count=count):
                self.chain(count)
                result = self.check()
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["state"], "pending_" + EVENTS[count].replace("-", "_"))
                self.assertEqual(result["missing"], [self.paths[EVENTS[count]]])
                self.assertEqual(result["producer"], PRODUCERS[count])

    def test_gap_is_invalid_and_other_latest_files_are_ignored(self):
        self.put(EVENTS[1], {})
        self.assertEqual(self.check()["reason"], "marker_sequence_gap")
        Path(self.paths[EVENTS[1]]).unlink()
        (self.root / "latest-ready.json").write_text("not even JSON")
        self.assertEqual(self.check()["state"], "pending_caller_ready")

    def test_wrong_external_binding_pin_or_attempt_cannot_be_inferred(self):
        self.assertEqual(self.check(attempt_binding_sha256="0" * 64)["state"], "blocked_stale_or_mismatch")
        self.assertEqual(self.check(expect_attempt="different")["reason"], "attempt_mismatch")

    def test_expired_attempt_and_future_binding(self):
        self.assertEqual(self.check(clock=timestamp(self.b["deadline"]))["state"], "blocked_deadline_exceeded")
        self.assertEqual(self.check(clock=timestamp(self.b["created_at"]) - timedelta(seconds=1))["reason"],
                         "binding_from_future")

    def test_caller_freshness_is_not_renewed_by_marker(self):
        caller = copy.deepcopy(self.base.tui.caller)
        caller["checkedAt"] = (self.clock - timedelta(seconds=1801)).isoformat()
        self.b["created_at"] = (self.clock - timedelta(seconds=1802)).isoformat()
        self.bind()
        self.caller = self.put("caller_receipt", caller)
        self.chain(1)
        self.assertEqual(self.check()["reason"], "caller_stale_or_future")
        caller["checkedAt"] = (self.clock + timedelta(seconds=1)).isoformat()
        self.caller = self.put("caller_receipt", caller)
        self.chain(1)
        self.assertEqual(self.check()["reason"], "caller_stale_or_future")

    def test_observation_old_context_or_future_context_is_rejected(self):
        original = parse(pinned(self.observation))
        for delta in (-1801, 1):
            self.observation = self.put("session_observation", dict(original,
                observed_at=(self.clock + timedelta(seconds=delta)).isoformat()))
            self.chain(2)
            self.assertEqual(self.check()["reason"], "observation_stale_or_future")

    def test_identity_variants_fail(self):
        for key in ("terminal", "incarnation", "pane_key", "process_incarnation"):
            original = self.b["coordinator"][key]
            self.b["coordinator"][key] = "wrong"
            self.bind()
            self.chain(1)
            self.assertFalse(self.check()["ok"], key)
            self.b["coordinator"][key] = original

    def test_consumes_conflict_and_pure_observation_pin(self):
        refs = self.chain(2)
        self.edit(EVENTS[1], consumes=dict(refs[0], event=EVENTS[0], sha256="0" * 64))
        self.assertEqual(self.check()["state"], "blocked_marker_conflict")
        self.chain(2)
        self.edit(EVENTS[1], session_observation=dict(self.observation, kind="trae_tui_startup_anchor"))
        self.assertFalse(self.check()["ok"])

    def test_schema_bool_and_duplicate_keys_rejected(self):
        for values in (dict(schema_version=True), dict(sequence=True), dict(execution_authorized=0),
                       dict(context=dict(context_max_age_seconds=1800, requires_live_caller_check=1))):
            self.chain(1)
            self.edit(EVENTS[0], **values)
            self.assertFalse(self.check()["ok"], values)
        self.chain(1)
        p = Path(self.paths[EVENTS[0]])
        p.write_bytes(p.read_bytes().rstrip()[:-1] + b',"event":"caller-ready"}')
        self.assertFalse(self.check()["ok"])

    def test_missing_reference_and_nonregular_or_symlink_marker(self):
        self.chain(1)
        target = Path(self.paths[EVENTS[0]])
        saved = target.read_bytes()
        target.unlink()
        target.symlink_to(self.paths["caller_receipt"])
        self.assertFalse(self.check()["ok"])
        target.unlink()
        os.mkfifo(target)
        self.assertFalse(self.check()["ok"])
        target.unlink()
        target.write_bytes(saved)
        Path(self.caller["path"]).unlink()
        self.assertEqual(self.check()["reason"], "binding_or_committed_reference_missing")

    def test_review_reject_original_operator_and_exact_subjects(self):
        for values, reason in ((dict(decision="reject"), "operator_rejected"),
                               (dict(operator=dict(self.b["operator"], terminal="another")), "review_result_mismatch"),
                               (dict(subject_refs=[self.caller]), "review_result_mismatch"),
                               (dict(identity_verified=True), "review_result_mismatch")):
            self.chain(3)
            self.edit("contract_review", **values)
            result = self.check()
            self.assertFalse(result["ok"])
            self.assertEqual(result["reason"], reason)

    def test_readiness_order_metadata_and_bool_types(self):
        self.chain()
        original = parse(pinned(file_ref(self.paths[EVENTS[3]])))
        refs = original["readiness_evidence"]
        for values in (dict(readiness_evidence=list(reversed(refs))),
                       dict(readiness_evidence=[dict(refs[0], role="skill"), *refs[1:]]),
                       dict(evidence_roles=[dict(ref=self.caller, role="wrong")]),
                       dict(required_refs=dict(skill_read_evidence_present=1, file_tool_probe_evidence_present=True))):
            self.put(EVENTS[3], dict(original, **values))
            self.assertFalse(self.check()["ok"], values)

    def test_readiness_self_reference_and_wrong_fixed_fields(self):
        self.chain()
        self.edit("final_readiness", evidence=[file_ref(self.paths["final_readiness"])])
        self.assertFalse(self.check()["ok"])
        self.chain(3)
        self.edit("contract_fields", cli=self.caller)
        self.assertFalse(self.check()["ok"])

    def test_pin_drift_during_check_fails_recheck(self):
        self.chain(1)
        original = EvidenceReader.recheck
        def drift(reader):
            Path(self.caller["path"]).write_text("changed")
            original(reader)
        with patch.object(EvidenceReader, "recheck", drift):
            self.assertEqual(self.check()["reason"], "file_pin_changed")

    def test_cli_dispatch_and_no_execute_mode(self):
        args = ["strict-bootstrap-state", "--bootstrap", str(self.root), "--expect-attempt", "attempt-test",
                "--attempt-binding-sha256", self.binding["sha256"], "--check"]
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(main(args), 0)
        self.assertFalse(json.loads(output.getvalue())["ready"])
        completed = subprocess.run([sys.executable, "-B", "coordinator_launch.py", *args[0:-1], "--execute"],
                                   capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 2)
        self.assertFalse(Path(self.paths["request"]).exists())

    def test_invalid_contents_do_not_leak_to_output(self):
        self.chain(1)
        Path(self.caller["path"]).write_text("authToken=private-fixture")
        result = self.check()
        self.assertFalse(result["ok"])
        self.assertNotIn("private-fixture", json.dumps(result))


class ReviewRoutesTests(unittest.TestCase):
    def test_new_request_uses_original_operator_execution_opportunity(self):
        for session, route in (("tool_wait", "return_tool_for_review"), ("busy", "defer_to_safe_point"),
                               ("idle", "blocked_operator_resume_unsupported"), ("unknown", "reconcile_delivery")):
            self.assertEqual(review_route(delivery="new", session=session), route)
        self.assertEqual(review_route(delivery="new", session="idle", safe_point_supported=True), "request_safe_point")

    def test_accepted_unknown_or_started_never_resends(self):
        for delivery in ("submitted", "input_accepted", "unknown"):
            self.assertEqual(review_route(delivery=delivery, session="idle"), "reconcile_delivery")
        self.assertEqual(review_route(delivery="turn_started", session="busy"), "await_result")
        self.assertEqual(review_route(delivery="completed", session="idle"), "reconcile_result")

    def test_stop_precedes_result_and_approval_only_routes_to_validation(self):
        self.assertEqual(review_route(delivery="completed", session="idle", stopped=True, decision="approve"), "stop")
        self.assertEqual(review_route(delivery="completed", session="unknown", decision="approve"), "validate_review")
        self.assertEqual(review_route(delivery="completed", session="idle", decision="reject"), "blocked_review_rejected")
        with self.assertRaises(ValueError):
            review_route(delivery="input_accepted", session="idle", decision="approve")


if __name__ == "__main__":
    unittest.main()
