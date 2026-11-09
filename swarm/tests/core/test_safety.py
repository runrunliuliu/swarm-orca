"""Offline regressions for the failed startup; fixtures contain no real prompts."""

import copy
from contextlib import redirect_stdout, redirect_stderr
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from supervisor.config import SafetyError
from supervisor.launch_guard import preflight, startup_diagnosis
from supervisor import receipts
from supervisor.safety import main
from core.test_supervisor import config


def startup():
    receipt = {"exit_code": 1, "receipt": {"ok": True, "result": {
        "runId": "run-1", "taskId": "task-1", "dispatchId": "dispatch-1",
        "state": "outcome_unknown", "stage": "startup_handshake_unobserved",
        "effects": [{"kind": "terminal", "role": "agent", "id": "term-1"}]}}}
    evidence = {"run_id": "run-1", "task_id": "task-1", "dispatch_id": "dispatch-1", "terminal_handle": "term-1",
                "turn_contexts": [{"approval_policy": "never"}],
                "tool_requests": [{"call_id": "call-1", "input": 'sandbox_permissions: "require_escalated"'}],
                "tool_results": [{"call_id": "call-1", "output": [{"type": "input_text", "text":
                    "approval policy is Never; reject command — cannot ask for escalated permissions"}]}]}
    return receipt, evidence


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.c = config(Path("/synthetic-only"))

    def test_verified_static_contract(self):
        self.assertEqual(preflight(self.c)["scope"], "offline_operator_evidence_only")

    def test_missing_and_unknown_contract_rejected(self):
        for value in (None, {}, {"schema_version": 3},
                      {**self.c["launch_contract"], "schema_version": 1},
                      {**self.c["launch_contract"], "schema_version": True},
                      {**self.c["launch_contract"], "schema_version": 2.0}):
            with self.subTest(value=value), self.assertRaises(SafetyError):
                preflight({**self.c, "launch_contract": value})

    def test_default_permissions_allow_never_without_escalation_support(self):
        for explicit in (False, True):
            c = copy.deepcopy(self.c)
            for policy in c["launch_contract"]["roles"].values():
                policy["approval_policy"] = "never"
                policy.pop("escalation_supported")
                if explicit:
                    policy["sandbox_permissions"] = "use_default"
            with self.subTest(explicit=explicit):
                self.assertTrue(preflight(c)["compatible"])

    def test_default_permissions_allow_on_request_without_escalation_support(self):
        for policy in self.c["launch_contract"]["roles"].values():
            policy["approval_policy"] = "on-request"
        self.assertTrue(preflight(self.c)["compatible"])

    def test_never_rejected_only_when_explicit_escalation_is_required(self):
        for role in self.c["agents"]:
            c = copy.deepcopy(self.c)
            c["launch_contract"]["roles"][role].update(
                sandbox_permissions="require_escalated", escalation_supported=True)
            with self.subTest(role=role), self.assertRaisesRegex(SafetyError, "approval_policy_conflict"):
                preflight(c)

    def test_full_access_label_is_not_effective_policy(self):
        for policy in ("Full Access", None, "", "allow-all"):
            c = copy.deepcopy(self.c)
            c["launch_contract"]["roles"]["coordinator"]["approval_policy"] = policy
            with self.subTest(policy=policy), self.assertRaisesRegex(SafetyError, "approval_policy_unverified"):
                preflight(c)

    def test_explicit_escalation_requires_verified_tool_support(self):
        for support in (False, None, "true"):
            c = copy.deepcopy(self.c)
            c["launch_contract"]["roles"]["coordinator"].update(
                sandbox_permissions="require_escalated", approval_policy="on-request", escalation_supported=support)
            with self.subTest(support=support), self.assertRaisesRegex(SafetyError, "escalation_unverified"):
                preflight(c)

    def test_explicit_supported_escalation_remains_compatible(self):
        for policy in self.c["launch_contract"]["roles"].values():
            policy.update(sandbox_permissions="require_escalated", approval_policy="on-request", escalation_supported=True)
        self.assertTrue(preflight(self.c)["compatible"])

    def test_unknown_execution_modes_rejected(self):
        for mode in (None, "", "Full Access", "danger-full-access", True, []):
            c = copy.deepcopy(self.c)
            c["launch_contract"]["roles"]["coordinator"]["sandbox_permissions"] = mode
            with self.subTest(mode=mode), self.assertRaisesRegex(SafetyError, "invalid_sandbox_permissions"):
                preflight(c)

    def test_bare_or_different_cli_rejected_at_each_entry(self):
        for entry in ("operator", "heartbeat", "recovery"):
            for cli in ("orca", "orca-ide", "/other/orca-server-cli"):
                c = copy.deepcopy(self.c)
                c["launch_contract"]["roles"]["implementation"]["cli_entries"][entry] = cli
                with self.subTest(entry=entry, cli=cli), self.assertRaisesRegex(SafetyError, "cli_mismatch"):
                    preflight(c)

    def test_launcher_change_invalidates_evidence(self):
        for section, key, value in (("runtime", "runtime_id", "new-runtime"), ("agents", "review", {"agent": "trae"})):
            c = copy.deepcopy(self.c)
            c[section][key] = value
            with self.subTest(section=section), self.assertRaisesRegex(SafetyError, "target_changed"):
                preflight(c)

    def test_startup_causal_diagnosis_does_not_infer_exit_or_retry(self):
        receipt, evidence = startup()
        result = startup_diagnosis(receipt, evidence)
        self.assertEqual(result["diagnosis"], "approval_policy_conflict")
        self.assertFalse(result["ready"])
        self.assertFalse(result["automatic_retry_allowed"])
        self.assertTrue(result["native_state_recheck_required"])
        self.assertNotIn("tool_results", result)

    def test_ok_true_is_not_ready(self):
        self.assertEqual(startup_diagnosis(startup()[0])["diagnosis"], "startup_not_ready")

    def test_evidence_requires_exact_native_identity(self):
        for field in ("run_id", "task_id", "dispatch_id", "terminal_handle"):
            receipt, evidence = startup()
            evidence[field] = "wrong"
            with self.subTest(field=field), self.assertRaises(SafetyError):
                startup_diagnosis(receipt, evidence)

    def test_refusal_requires_matching_call_and_policy(self):
        for field in ("call", "policy", "request"):
            receipt, evidence = startup()
            if field == "call":
                evidence["tool_results"][0]["call_id"] = "other-call"
            elif field == "policy":
                evidence["turn_contexts"][0]["approval_policy"] = "on-request"
            else:
                evidence["tool_requests"] = []
            with self.subTest(field=field):
                self.assertEqual(startup_diagnosis(receipt, evidence)["diagnosis"], "startup_not_ready")

    def test_ready_conflicts_with_denial(self):
        receipt, evidence = startup()
        receipt["exit_code"] = 0
        receipt["receipt"]["result"]["state"] = "ready"
        self.assertEqual(startup_diagnosis(receipt, evidence)["diagnosis"], "conflicting_startup_evidence")
        self.assertTrue(startup_diagnosis(receipt)["ready"])

    def test_transport_failure_cannot_be_ready(self):
        receipt, _ = startup()
        receipt["receipt"]["result"]["state"] = "ready"
        self.assertFalse(startup_diagnosis(receipt)["ready"])


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / "original"
        self.source.mkdir()
        self.dest = self.root / "derived"
        self.file = self.source / "operator-final.json"
        self.file.write_text(json.dumps({"nested": [{"preview": "private TUI text"}], "id": "term-1"}))

    def test_recursive_scrub_is_idempotent_and_preserves_other_fields(self):
        value = {"a": [{"Preview_Text": "secret", "id": 1}], "terminal-preview": {"nested": "secret"}}
        clean = receipts.scrub(value)
        self.assertEqual(clean, {"a": [{"Preview_Text": receipts.MARKER, "id": 1}], "terminal-preview": receipts.MARKER})
        self.assertEqual(receipts.scrub(clean), clean)

    def test_serialized_json_stdout_does_not_reintroduce_preview(self):
        value = {"stdout": json.dumps({"result": {"preview": "nested private text", "id": "term-1"}}),
                 "unchanged": "[ordinary prose, not JSON]"}
        clean = receipts.scrub(value)
        self.assertNotIn("nested private text", json.dumps(clean))
        self.assertEqual(json.loads(clean["stdout"])["result"]["id"], "term-1")
        self.assertEqual(clean["unchanged"], value["unchanged"])

    def test_derive_preserves_original_and_hashes_all_output(self):
        before = self.file.read_bytes()
        report = receipts.derive(self.source, self.dest)
        self.assertFalse(report["public_release_approved"])
        self.assertEqual(self.file.read_bytes(), before)
        self.assertNotIn("private TUI text", (self.dest / self.file.name).read_text())
        manifest = json.loads((self.dest / receipts.MANIFEST).read_text())
        row = manifest["files"][0]
        self.assertEqual(row["original_sha256"], hashlib.sha256(before).hexdigest())
        self.assertEqual(row["sanitized_sha256"], hashlib.sha256((self.dest / self.file.name).read_bytes()).hexdigest())
        self.assertTrue(receipts.check(self.dest, sealed=True)["sealed"])

    def test_unsanitized_check_never_prints_content(self):
        with self.assertRaises(SafetyError) as raised:
            receipts.check(self.source)
        self.assertNotIn("private TUI text", str(raised.exception))

    def test_late_unsafe_or_safe_additions_invalidate_seal(self):
        receipts.derive(self.source, self.dest)
        late = self.dest / "accounting-late.json"
        for value in ({"preview": "new private text"}, {"id": "safe-but-not-sealed"}):
            late.write_text(json.dumps(value))
            with self.subTest(value=value), self.assertRaises(SafetyError):
                receipts.check(self.dest, sealed=True)

    def test_changed_or_deleted_receipt_invalidates_seal(self):
        receipts.derive(self.source, self.dest)
        target = self.dest / self.file.name
        target.write_text('{"id":"changed"}')
        with self.assertRaisesRegex(SafetyError, "hash_changed"):
            receipts.check(self.dest, sealed=True)
        target.unlink()
        with self.assertRaises(SafetyError):
            receipts.check(self.dest, sealed=True)

    def test_refuses_overwrite_and_source_destination_overlap(self):
        for dest in (self.source, self.source / "nested", self.root):
            with self.subTest(dest=dest), self.assertRaises(SafetyError):
                receipts.derive(self.source, dest)
        receipts.derive(self.source, self.dest)
        with self.assertRaises(SafetyError):
            receipts.derive(self.source, self.dest)

    def test_symlink_file_or_directory_refused(self):
        link = self.source / "link"
        for target in (self.file, self.root):
            link.symlink_to(target)
            with self.subTest(target=target), self.assertRaisesRegex(SafetyError, "symlink"):
                receipts.derive(self.source, self.dest)
            link.unlink()

    def test_non_json_is_excluded_with_provenance_not_copied(self):
        (self.source / "report.md").write_text("not automatically sanitized")
        receipts.derive(self.source, self.dest)
        self.assertFalse((self.dest / "report.md").exists())
        manifest = json.loads((self.dest / receipts.MANIFEST).read_text())
        self.assertEqual(manifest["excluded"][0]["path"], "report.md")

    def test_source_change_during_derivation_does_not_seal(self):
        original_read = receipts.read

        def changing_read(path):
            content = original_read(path)
            if path == self.file:
                (self.source / "late.json").write_text("{}")
            return content

        with patch.object(receipts, "read", changing_read), self.assertRaisesRegex(SafetyError, "source_changed"):
            receipts.derive(self.source, self.dest)
        self.assertFalse((self.dest / receipts.MANIFEST).exists())

    def test_malformed_receipt_fails_closed_without_raw_output(self):
        self.file.write_text("invalid sensitive text")
        output = io.StringIO()
        with redirect_stderr(output):
            code = main(["derive-receipts", "--source", str(self.source), "--destination", str(self.dest)])
        self.assertEqual(code, 2)
        self.assertNotIn("sensitive text", output.getvalue())
        self.assertFalse((self.dest / receipts.MANIFEST).exists())

    def test_cli_diagnosis(self):
        receipt, evidence = startup()
        r, e = self.root / "receipt.json", self.root / "evidence.json"
        r.write_text(json.dumps(receipt))
        e.write_text(json.dumps(evidence))
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(["diagnose", "--receipt", str(r), "--evidence", str(e)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["diagnosis"], "approval_policy_conflict")
