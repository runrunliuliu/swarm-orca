"""Real pinned RSI CLI; no model, native calls, or target-checkout mutation."""

from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import shlex
import shutil
import sys
import unittest
from unittest.mock import patch

from coordinator_io import canonical, digest, file_ref, parse, pinned, publish_new
from operator_authority import check, reconcile
from coordinator_authority_bundle import GENERATE, ADAPTER, PROTOCOL, verify_bundle
from operator_prepare import main
import core.test_tui_rsi_integration as integration


@unittest.skipUnless(os.environ.get("RSI_CHECKER_TEST_ROOT"), "explicit real RSI checkout required")
class OperatorAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.rsi = integration.RsiIntegrationTests()
        self.rsi.setUp()
        self.addCleanup(self.rsi.doCleanups)
        self.root = self.rsi.source_root
        self.directory = self.root / "operator-check"
        self.directory.mkdir(mode=0o700)
        self.source = self.rsi.source()
        self.context = dict(schema_version=1, run_id="run_test", scope_id="test-scope",
            authority_sha256=digest(canonical(self.rsi.authority)),
            contract_sha256=digest(canonical(self.rsi.contract)), paths=[dict(
                id=p["id"], operation=p["operation"], permissions=["local_edit"]) for p in self.source["paths"]])
        self.gates = dict(schema_version=1, paths=[dict(id=p["id"], technical="not_ready", platform="allowed",
                     evidence_refs=["fixture://native-dispatch"]) for p in self.source["paths"]])
        self.inputs = {"authority": self.rsi.authority_ref, "contract": self.rsi.contract_ref,
                       "handoff": self.rsi.handoff}
        for name, value in (("context", self.context), ("checkpoint", self.source), ("gates", self.gates)):
            self.inputs[name] = self.write(name + ".json", value)
        checker = self.rsi.root
        self.spec = dict(schema_version=1, mode="check-authorized-progress", directory=str(self.directory),
            read_roots=[str(self.root), str(checker)], write_roots=[str(self.directory)],
            checker={"root": str(checker), "files": {
                str(p.relative_to(checker)): digest(p.read_bytes()) for p in (checker / "rsi").rglob("*.py")}},
            inputs=self.inputs, source_root=str(self.root), run_id="run_test", scope_id="test-scope")
        self.save()

    def write(self, name, value):
        target = self.root / name
        # Intentionally pretty formatted: raw hashes differ from canonical pins.
        target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        return file_ref(target)

    def save(self):
        self.ref = self.write("operator-input.json", self.spec)

    def test_real_cli_uses_canonical_pins_and_preserves_success_envelope(self):
        result = check(self.ref)
        self.assertTrue(result["ok"], result)
        for name in ("context", "contract", "checkpoint"):
            self.assertNotEqual(result["digests"][name]["file_sha256"],
                                result["digests"][name]["canonical_sha256"])
        receipt = parse(pinned(result["receipt"]))
        self.assertEqual(receipt["authority_check"]["context_sha256"], digest(canonical(self.context)))
        self.assertTrue(receipt["result"]["consistent"])
        self.assertFalse(result["execution_authorized"])
        self.assertEqual(pinned(result["receipt"]), (self.directory / "checker-stdout.txt").read_bytes())
        from coordinator_tui_checkpoint import FIELDS, validate_domain
        validate_domain({
            "checkpoint": {key: self.source[key] for key in FIELDS},
            "domain_check": {"adapter": "rsi-authorized-progress-v1",
                             "source": self.inputs["checkpoint"], "receipt": result["receipt"]}},
            {"run": {"id": "run_test"}, "observation": {"roots": [str(self.root)]}})
        before = {p.name: p.read_bytes() for p in self.directory.iterdir()}
        with self.assertRaisesRegex(ValueError, "attempt_not_empty"):
            check(self.ref)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.directory.iterdir()})

    def test_failure_preserves_stderr_and_never_publishes_receipt(self):
        self.gates["paths"][0]["technical"] = "ready"
        self.inputs["gates"] = self.write("gates.json", self.gates)
        self.save()
        result = check(self.ref)
        self.assertFalse(result["ok"])
        failure = parse(pinned(result["failure"]))
        self.assertEqual(failure["returncode"], 2)
        self.assertIn("technical_blocker_conflict", pinned(failure["stderr"]).decode())
        self.assertFalse((self.directory / "receipt.json").exists())
        self.assertFalse((self.directory / "check-completed.json").exists())

    def test_unchanged_semantics_but_changed_raw_bytes_are_not_auto_repinned(self):
        Path(self.inputs["context"]["path"]).write_bytes(canonical(self.context))
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            check(self.ref)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_drift_after_checker_preserves_attempt_without_success(self):
        run = subprocess.run
        def drift(*args, **kwargs):
            proc = run(*args, **kwargs)
            Path(self.inputs["context"]["path"]).write_text("{}")
            return proc
        with patch("operator_authority.subprocess.run", side_effect=drift):
            result = check(self.ref)
        self.assertFalse(result["ok"])
        self.assertFalse((self.directory / "receipt.json").exists())
        self.assertTrue((self.directory / "failure.json").exists())

    def test_original_authority_source_drift_rejected_before_claim(self):
        (self.root / "authority-source.txt").write_text("changed")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            check(self.ref)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_extra_checker_source_requires_new_independent_pin(self):
        self.spec["checker"]["files"].pop("rsi/authority.py")
        self.save()
        with self.assertRaisesRegex(ValueError, "file_set_changed"):
            check(self.ref)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_duplicate_json_rejected_before_claim(self):
        target = Path(self.inputs["context"]["path"])
        target.write_text('{"x":1,"x":2}')
        self.inputs["context"] = file_ref(target)
        self.save()
        with self.assertRaisesRegex(ValueError, "duplicate_json_key"):
            check(self.ref)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_handoff_uses_same_existing_cli(self):
        self.spec["mode"] = "check-authority-handoff"
        self.spec["inputs"] = {k: self.inputs[k] for k in ("authority", "handoff")}
        self.save()
        result = check(self.ref)
        self.assertTrue(result["ok"], result)
        self.assertFalse(parse(pinned(result["receipt"]))["result"]["grants_authority"])

    def test_claim_collision_has_no_failure_write_or_check(self):
        with patch("operator_authority.publish_new", side_effect=FileExistsError), \
             patch("operator_authority.subprocess.run") as run, self.assertRaises(FileExistsError):
            check(self.ref)
        run.assert_not_called()
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_failure_on_snapshot_write_is_not_retried(self):
        calls = []
        def denied(target, value):
            calls.append(target.name)
            if target.name.startswith("source-"):
                raise PermissionError(13, "permission denied")
            publish_new(target, value)
        with patch("operator_authority.publish_new", side_effect=denied), \
             patch("operator_authority.subprocess.run") as run:
            result = check(self.ref)
        run.assert_not_called()
        self.assertEqual(calls, ["check-intent.json", "source-000.snapshot", "failure.json"])
        self.assertEqual(parse(pinned(result["failure"]))["os_error"], "EACCES")

    def test_cli_no_execute_writes_nothing(self):
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(["check-authority", "--input", self.ref["path"], "--input-sha256", self.ref["sha256"]])
        self.assertEqual(code, 2)
        self.assertEqual(list(self.directory.iterdir()), [])

    def generated(self, label="generation"):
        directory = self.root / label
        directory.mkdir(mode=0o700)
        spec = dict(self.spec, schema_version=1, mode=GENERATE, directory=str(directory),
                    write_roots=[str(self.root)], inputs={"authority": self.inputs["authority"]})
        ref = self.write(label + "-input.json", spec)
        result = check(ref)
        self.assertTrue(result["ok"], result)
        verify_bundle(result["completion"], [str(self.root)])
        return result

    def test_real_generation_to_progress_to_shared_checkpoint_validation(self):
        generated = self.generated()
        self.spec.update(schema_version=2, generation=generated["completion"])
        self.inputs["handoff"] = generated["handoff"]
        self.save()
        checked = check(self.ref)
        self.assertTrue(checked["ok"], checked)
        self.assertEqual(pinned(checked["receipt"]), (self.directory / "checker-stdout.txt").read_bytes())
        from coordinator_tui_checkpoint import FIELDS, validate_record
        f = self.rsi.f
        f.config.update(schema_version=2, scheduler=dict(terminal="term_sender", incarnation="inc_sender", workspace="ws_sender"),
            authority_binding=dict(protocol=PROTOCOL, generation=generated["completion"], scope_id="test-scope",
                                   context=self.inputs["context"], contract=self.inputs["contract"]))
        f.record["checkpoint"] = {key: self.source[key] for key in FIELDS}
        f.record["domain_check"] = dict(adapter=ADAPTER, source=self.inputs["checkpoint"],
            receipt=checked["receipt"], completion=checked["completion"])
        _, route = validate_record(f.record, f.config, f.c)
        self.assertEqual(route.kind, "dependency_wait")
        self.assertTrue(reconcile(self.ref)["ok"])

    def test_real_incremental_workers_and_judge_preserve_other_fields(self):
        initial = self.rsi.authority["events"][0]
        initial["patch"].update({"permissions.training": "granted", "permissions.push": "denied",
            "limits.tokens": {"mode": "bounded", "value": 40000}, "models.simulator": "sim-original",
            "models.judge": "judge-original"})
        self.inputs["authority"] = self.write("authority-inheritance.json", self.rsi.authority)
        baseline = parse(pinned(self.generated("inherit-initial")["handoff"]))
        for index, patch_value in enumerate(({"limits.max_workers": {"mode": "bounded", "value": 7}},
                                             {"models.judge": "judge-new"})):
            original = self.root / f"increment-{index}.txt"
            original.write_text("TEST FIXTURE ONLY: " + json.dumps(patch_value))
            self.rsi.authority["events"].append(dict(id=f"patch-{index}", actor="user",
                source=dict(path=original.name, sha256=digest(original.read_bytes()), excerpt=original.read_text()),
                patch=patch_value))
            self.inputs["authority"] = self.write(f"authority-inheritance-{index}.json", self.rsi.authority)
            after = parse(pinned(self.generated(f"inherit-{index}")["handoff"]))
            for key in baseline["fields"]:
                if key not in patch_value:
                    self.assertEqual(after["fields"][key], baseline["fields"][key])
                    self.assertEqual(after["origins"][key], baseline["origins"][key])
            for key, value in patch_value.items():
                self.assertEqual(after["fields"][key], value)
            baseline = after

    def test_real_generator_shell_smoke_bash_and_zsh(self):
        for shell in ("bash", "zsh"):
            with self.subTest(shell=shell):
                self.assertIsNotNone(shutil.which(shell), f"{shell} required for shell smoke test")
                directory = self.root / ("shell-" + shell)
                directory.mkdir(mode=0o700)
                spec = dict(self.spec, schema_version=1, mode=GENERATE, directory=str(directory),
                    write_roots=[str(self.root)], inputs={"authority": self.inputs["authority"]})
                ref = self.write(shell + "-input.json", spec)
                argv = [sys.executable, "-B", str(Path(__file__).resolve().parents[2] / "operator_prepare.py"),
                        "check-authority", "--input", ref["path"], "--input-sha256", ref["sha256"], "--execute"]
                proc = subprocess.run([shell, "-c", shlex.join(argv)], capture_output=True, timeout=30)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                reply = parse(proc.stdout)
                self.assertTrue(reply["ok"], reply)
                verify_bundle(reply["completion"], [str(self.root)])

    def test_real_two_valid_generations_cannot_be_substituted(self):
        first, second = self.generated("first-generation"), self.generated("second-generation")
        self.assertEqual(pinned(first["handoff"]), pinned(second["handoff"]))
        self.spec.update(schema_version=2, generation=first["completion"])
        self.inputs["handoff"] = second["handoff"]
        self.save()
        with self.assertRaisesRegex(ValueError, "generation_mismatch"):
            check(self.ref)
        self.assertEqual(list(self.directory.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
